# P1-2 plan adversarial review — round 2

Reviewed the r1 revision against the round-1 report, P1/P1-1 plans, current enrollment/registry/plugin code, and a fresh repository-wide `rg` inventory. Fixed product and scope decisions were treated as constraints.

## Round-1 finding verification

| r1 finding | Status | Verification |
|---|---|---|
| B1 ambiguous durable commit | **PARTIAL** | `committedBy` plus same-op retry now recovers a retained result, but payload binding conflicts with idempotent-first precedence and eviction bounds recovery without an explicit operation-result horizon (§2.2/§2.3). |
| B2 lease is not a fence | **RESOLVED** | The revision makes repository `now <= leaseUntil` and opId ownership one atomic precondition, rejects post-expiry commits without reclaim, and tests equality/reclaim order (`P1-2-PLAN.md:200-230,457-464`). |
| M1 denial cannot cancel approval | **RESOLVED** | `tryDeny` atomically accepts `pending|approving`, invalidates the claim, and deny/commit orders are explicitly tested (`P1-2-PLAN.md:181-186,340-347,478-481`). |
| M2 split A2 reconciliation | **RESOLVED** | The split reads/register are replaced by one atomic operation with virgin-slot preconditions and race outcomes; history/tombstones intentionally prevent resurrection (`P1-2-PLAN.md:188-192,365-383,494-498`; `P1-1-PLAN.md:174-188`). |
| M3 portable SPI contract | **PARTIAL** | Collision errors, transaction scope, Redis Cluster exclusion, and PG/Redis sketches were added, but idempotent payload validation and some locking/error semantics remain incomplete (N2 below). |
| M4 approved retention/pickup | **NOT RESOLVED** | `approvedAt` fixes the sweep origin, but the unchanged plugin stops polling at `expires_in`, so the advertised post-approval retrieval window is not usable by the real client (N1 below). |
| M5 incomplete migration inventory | **PARTIAL** | The deleted-type construction sites are substantially inventoried, but `enrollment-http-handler.ts` is absent even though it directly dispatches `ApproveOutcome`; “approve adapters 4곳” is not an auditable file list (N4 below). |
| M6 insufficient conformance harness | **PARTIAL** | Clock and commit-after-mutation capabilities were added, but their ownership is ambiguous and no barriers exist for several promised integration interleavings (N5 below). |
| m1 overbroad current-code race wording | **RESOLVED** | The revision correctly distinguishes unlocked poll from cross-replica approve/deny risk (`P1-2-PLAN.md:43-49`; current code `device-flow-enrollment.ts:611-620,678-713,813-834`). |
| m2 poll stale-read response | **RESOLVED** | `tryExpire` returns post-operation state and poll is required to branch on it (`P1-2-PLAN.md:155-159,349-360`). |

## New findings

### BLOCKER

None.

### MAJOR

#### N1. The post-approval pickup window is unreachable for the unchanged plugin

The plan redefines `expires_in` as an approval deadline and promises that an approved record remains pollable through `approvedAt + retentionMs` (`P1-2-PLAN.md:275-288,349-358`). But the actual plugin computes a local deadline from `expires_in`, polls only while `Date.now() < expiresAt`, and then throws without making another request (`packages/plugin/src/enrollment-client.ts:395-431`). Consequently, an approval committed just before the server deadline but not observed by the previous poll can be retained for five minutes and still never be retrieved by the intended client. Test 17 only calls the server poll path directly; it does not exercise the plugin loop (`P1-2-PLAN.md:523-529`). This also contradicts “plugin 쪽 무변경” (`P1-2-PLAN.md:285-286`).

**Suggested fix.** Either keep `expires_in` as the end-to-end pickup deadline and reject commits too late to be polled, or change the wire/client contract so the plugin continues polling through a specified result-retrieval grace window. Add an end-to-end plugin test for approval immediately before the approval deadline whose first successful poll occurs after that deadline.

#### N2. Idempotent-first precedence bypasses the normative payload-binding rule

The fencing rules return the saved result immediately when `status === approved && committedBy === opId` (`P1-2-PLAN.md:202-206`). The portability rules separately require an `agentPublicKey` mismatch to throw (`P1-2-PLAN.md:263-268`). On a retry with the same opId but a different key—or different creds, peerId, or `expect`—rule 1 says to return the prior result before inspecting any payload. Thus adapters can conform to one paragraph only by violating the other, and only `agentPublicKey` is bound at all. This is consequential because the claimed B1 guarantee says the retry uses the “same opId·same payload,” but the repository does not enforce it (`P1-2-PLAN.md:325-332`).

**Suggested fix.** Persist a digest/canonical copy of every commit input and validate it before idempotent recovery; define a single `CommitPayloadMismatchError` (or exact outcome) for any mismatch. State whether `expect` participates. Add conformance cases for changed key, creds, peerId, and expect after a committed-but-thrown call.

#### N3. `poll` still uses caller time to decide whether repository expiry runs

Lease and expiry authority are said to belong to the repository (`P1-2-PLAN.md:207-212`), and Memory receives an injected repository clock (`P1-2-PLAN.md:115-118`). Yet the proposed poll flow gates `tryExpire` using `Date.now() > expiresAt` (`P1-2-PLAN.md:349-355`). With a lagging issuer clock, poll can keep returning `authorization_pending` after repository expiry; with conformance's advanced repository clock, the integration poll test cannot reach expiry unless wall time is also manipulated. This undermines the stated authority model and makes replicas disagree.

**Suggested fix.** Do not make time-sensitive decisions in `DeviceFlowEnrollment`. Add a repository `observeForPoll(deviceCode)`/`expireAndGetState(deviceCode)` operation that applies repository time and returns the current record/state atomically, or call `tryExpire` unconditionally and make it repository-time-aware. Ensure credentials needed for an approved response are included in the returned snapshot. Test issuer-clock skew explicitly.

#### N4. The migration matrix still omits a direct `ApproveOutcome` consumer

`packages/saas/src/enrollment-http-handler.ts` directly switches on approve outcomes and currently falls through to treating any unrecognized kind as approved (`packages/saas/src/enrollment-http-handler.ts:97-107`). It is absent from the source migration list (`P1-2-PLAN.md:399-410`), while the plan merely says “approve 어댑터 4곳” without naming those files (`P1-2-PLAN.md:392-394`). A TypeScript discriminated union extension does not necessarily fail compilation here because the code has no exhaustive switch; an omitted edit could turn `in_progress` into a runtime access of `outcome.result`.

**Suggested fix.** Name every approve adapter, add `packages/saas/src/enrollment-http-handler.ts` to the matrix, and require exhaustive `never` checks. Add a direct handler test proving `in_progress` maps to its distinct 409 response.

#### N5. The capability API cannot drive all tests the plan claims are deterministic

The harness places `clock` and failpoints beside `create()`, without specifying that they control each repo returned by `create`, how they reset between cases, or whether multiple independent clients share them (`P1-2-PLAN.md:435-445`). `advance(ms): void` is also insufficient for a remote adapter whose authoritative database clock must be changed asynchronously. More importantly, the integration suite promises ordered claim→mint→deny, expire-vs-commit, and lock-bypass interleavings using “fault-injection hooks” (`P1-2-PLAN.md:502-540`), but the only defined failpoint is throw-after-commit; there is no mint or operation barrier. The current Memory implementation is synchronous at repository RMW boundaries, exactly the limitation r1 M6 identified.

**Suggested fix.** Make capabilities instance-scoped in the factory result, make clock mutation async, define reset semantics, and add explicit barriers/hooks around after-claim, before-commit, and operation linearization (or narrow tests to observable nondeterministic allowed sets). Specify `throwAfterCommitMutation` as a one-shot post-durable-commit/pre-response failure for that exact repo/client and test reset/consumption.

### MINOR

#### n1. The state diagram omits the newly supported `approving -> denied` edge

The text under the diagram says approving is deniable, but the diagram draws `tryDeny` only from pending (`P1-2-PLAN.md:122-127`). The SPI and tests correctly include approving (`P1-2-PLAN.md:181-183,478-481`).

**Suggested fix.** Draw `approving --tryDeny--> denied` explicitly.

#### n2. Reconciliation noop precedence is not exact

`ReconcileOutcome` exposes distinct `active_present` and `history_present` reasons (`P1-2-PLAN.md:161-163`), but an active registry necessarily has history under P1-1's append-only model. The precondition says both must be empty, without defining which reason wins when both are non-empty (`P1-2-PLAN.md:188-192,370-375`). Conformance asks for each exact reason (`P1-2-PLAN.md:494-496`), so adapters may disagree.

**Suggested fix.** Specify precedence, e.g. `not_found > not_approved > active_present > history_present`, and add a both-present case. A revoked/superseded-only history should remain `history_present`; that is the intended P1-1 anti-resurrection behavior.

#### n3. `sweep(now?)` weakens the repository-authoritative-clock rule

The SPI accepts caller-supplied `now` (`P1-2-PLAN.md:194-196`) while fencing forbids caller time (`P1-2-PLAN.md:207-211`). This can make retention conformance adapter-dependent and permits premature eviction if exposed in production.

**Suggested fix.** Remove `now` from the public SPI and drive time only through the instance-scoped test clock capability.

## Focused interleaving conclusions

- **Commit persisted, response lost, then deny:** coherent as written. The atomic commit has already made the enrollment approved; `tryDeny` returns false, and the retry's rule 1 returns the saved committed result. Deny cannot create a contradictory terminal state (`P1-2-PLAN.md:181-183,202-217`). Add this exact three-step test anyway; current tests cover deny/commit order but not the post-mutation throw variant.
- **Approved eviction:** it does not enable double activation—after eviction, the old op returns `claim_lost`, and a new enrollment still encounters registry CAS/tombstone/history rules. It does, however, end B1 result recovery. The contract should explicitly state that idempotent recovery is guaranteed only until `approvedAt + retentionMs` and specify the boundary ordering with sweep.
- **ABA without generation:** under the stated global-nonreuse opId contract and one atomic RMW, opId match plus lease time is sufficient. Release→new claim replaces the opId; deny is terminal; eviction→re-enroll creates new codes/opIds. The plan should add a conformance test that reusing an opId is a caller-contract violation, not silently supported.
- **A2 with tombstone/history:** `history_present` noop is consistent with P1-1's permanent tombstone and no-resurrection semantics (`P1-1-PLAN.md:174-188`); it should not repair a slot that has any prior history.

## Verdict

**NEEDS_CHANGES** — 0 BLOCKER, 5 MAJOR, 3 MINOR.
