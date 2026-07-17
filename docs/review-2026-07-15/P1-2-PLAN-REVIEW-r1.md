# P1-2 plan adversarial review — round 1

Reviewed the r0 plan against the requested source files and repository-wide construction/import sites. The fixed product and scope decisions were treated as constraints.

## BLOCKER

### B1. `commitApproval` has no retry/result contract, so an ambiguous durable commit cannot be recovered safely

**Defect.** The SPI makes `commitApproval` a one-shot transition. If PostgreSQL commits and the connection drops before the response, or a Redis script completes and the client times out, the caller cannot distinguish success from failure. Retrying the same call is not specified: the enrollment is now `approved`, no claim exists, and the listed outcomes only provide `claim_lost`, not the winning result. Calling `releaseClaim` also cannot resolve the ambiguity. This silently drops the original review's `getOperationResult` requirement and its “mint success, commit timeout/retry” conformance case.

**Evidence.** The original review explicitly requires `getOperationResult` and a commit-timeout retry test (`docs/review-2026-07-15/P1.md:139-153`). The proposed union has no `already_committed`/result outcome and the SPI has no operation-result lookup (`docs/review-2026-07-15/P1-2-PLAN.md:136-155`). The test list exercises ordinary success/failure but not the original ambiguous timeout (`P1-2-PLAN.md:270-313`). The current plugin treats non-pending poll errors as fatal, making reliable persisted-result recovery consequential (`packages/plugin/src/enrollment-client.ts:410-415`).

**Suggested fix.** Persist `opId` with the approved result and specify either (a) idempotent `commitApproval(opId, ...)` that returns the exact prior committed result, including the enrollment result and registry record, or (b) `getOperationResult(opId)`. Define retention, uniqueness, payload-mismatch behavior, and the response after a timed-out winning commit. Add a fault-injected test where the mutation commits but the method throws, followed by retry/result lookup proving the exact same credentials are recovered and no second mint/activation occurs.

### B2. Lease expiry is not itself a fence, leaving a double-commit/reclaim race undefined

**Defect.** The plan says `opId` is a fencing token, but an opaque random owner ID is not a monotonic fence and the contract does not say whether a commit after `leaseUntil` but before another claim is accepted. If accepted, A can commit after its lease while B is concurrently reclaiming/minting; correctness depends on backend serialization details not stated in the outcome contract. If rejected, `claim_lost` must cover lease expiry even without reclaim, which the plan also does not state. “Lease is longer than mint” is only an operational hope; pauses, overloaded signers, remote KMS, or clock jumps can exceed it.

**Evidence.** The state machine permits reclaim after lease expiry (`P1-2-PLAN.md:114-120`), but `claim_lost` is defined only as no longer owning the claim (`:136-141`) and fencing is described only after expiry/reclaim (`:176-180`). Test 2 checks an old commit only after a new claim (`:271-274`); there is no boundary test for commit racing reclaim or committing after expiry without reclaim. No clock authority or comparison rule is specified.

**Suggested fix.** Make repository time authoritative and specify a linearization rule: `commitApproval` succeeds only when `opId` matches **and** repository `now <= leaseUntil`; otherwise it returns `claim_lost` without mutation. Reclaim must atomically replace the owner (prefer an incrementing claim generation/version in addition to an idempotency ID). Add controllable-clock tests for equality, post-expiry/no-reclaim, commit-vs-reclaim in both orders, clock rollback policy, and a mint that outlasts the lease. If long mints are expected, define bounded lease renewal with owner/generation fencing.

## MAJOR

### M1. Denial cannot cancel an in-flight approval, and the plan contradicts itself about expired claims

**Defect.** `tryDeny` accepts only `pending`, so an operator cannot stop approval of a compromised key once a claim is acquired—even after the lease expires. The plan says retrying denial after lease expiry “works,” while its tests correctly say it remains false forever unless another operation changes the state. Waiting for enrollment expiry can be many minutes, and a stalled claimant can still commit unless B2 is fixed.

**Evidence.** The SPI restricts denial to `pending` (`P1-2-PLAN.md:157-160`). The prose claims denial succeeds after lease expiry (`:220-223`), but tests 5 and 16 say expired-lease `approving` still cannot be denied and only expiry can terminate it (`:281-284`, `:306-309`). Current denial is pending-only, but current approving is merely an in-process span protected by the same lock; introducing a durable reclaimable state materially changes the operational situation (`packages/saas/src/device-flow-enrollment.ts:813-834`).

**Suggested fix.** Define an atomic cancel/deny transition for `pending` and `approving` (at least expired claims, preferably any claim under an explicit operator action) that writes `denied` and invalidates the claim generation immediately. A later commit must be fenced. Document that already-minted NATS credentials can remain orphaned under the fixed out-of-scope revocation decision, but cannot be committed or delivered. Add deny-vs-mint, deny-vs-commit, and deny-after-lease tests.

### M2. The A2 reconciliation path violates the advertised atomic coupling and is race-underspecified

**Defect.** An `already_approved` call performs a standalone `register` outside any enrollment transaction or claim. That directly contradicts the completion claim that approval and activation “always” appear in one commit. It can also race with a new enrollment's claim/gate/commit or `revokeActive`: the two reads (`getActive`, then `listHistory`) do not form a snapshot, and the plan never states which outcomes are acceptable or whether credentials may be returned when reconciliation loses.

**Evidence.** A2 explicitly calls standalone `register(expect=null)` without a claim (`P1-2-PLAN.md:201-203`). `AgentKeyRegistry` readers are individually coherent, not a multi-call snapshot (`packages/saas/src/agent-key-registry.ts:28-42`). Current A2 performs the same split read/register and returns credentials even if repair fails (`packages/saas/src/device-flow-enrollment.ts:737-751`). The proposed guarantee says approved credentials and activation always commit together (`P1-2-PLAN.md:346-347`), while the atomicity text narrows that only to the commit path (`:168-172`). Test 14 merely asserts that A2 creates no claim (`:304-305`) and has no cross-enrollment/revoke race.

**Suggested fix.** Replace the split reconciliation with a repository operation such as `reconcileApproved(deviceCode)` that atomically verifies the persisted approved record, registry emptiness/history conditions, and activation—or explicitly classify A2 as legacy repair and weaken the global guarantee. Specify and test races against another enrollment commit and revoke, including what the caller receives when repair loses. Prefer returning a persisted operation result without mutating registry once B1 is implemented.

### M3. The SPI is not sufficiently specified to be portable to realistic PostgreSQL/Redis adapters

**Defect.** “One transaction” is asserted, but entity identity, uniqueness, key placement, isolation, and error mapping are missing. `commitApproval(opId, commit)` locates a claim solely by globally supplied `opId`; global uniqueness/collision behavior is not contractual, and the supplied `agentPublicKey` is not explicitly required to equal the claimed enrollment's key. `createEnrollment` specifies user-code collision but leaves device-code collision as “reject or specified error,” which is not a conformance contract. A Redis Cluster implementation additionally needs every enrollment/index/registry/history key touched by the Lua/transaction to share a hash slot; tenant/account registry keys and random device/user-code indexes do not naturally do so.

**Evidence.** The underspecified signatures and outcomes are at `P1-2-PLAN.md:128-163`; test 7 explicitly permits unspecified device collision behavior (`:285-286`). The atomicity text only says same record/slot operations have a serialization point (`:166-181`) but `commitApproval` spans an enrollment plus a tenant/account slot and history. Current registry semantics require tombstone > same-key > CAS precedence (`packages/saas/src/agent-key-registry.ts:82-113`), all of which must be evaluated in that same boundary.

**Suggested fix.** Add normative pre/postconditions: globally unique op ID (or address by device code + claim generation), payload binding to immutable enrollment tenant/account/public key, explicit mismatch outcome, device- and user-code unique constraints/errors, isolation/serialization scope across both entities and history, and defensive snapshot rules. Include implementability sketches for PostgreSQL (unique indexes plus row/advisory locking and transaction isolation/retry) and Redis (single hash-slot key model or explicitly exclude Redis Cluster). Make conformance outcomes exact rather than adapter-selected.

### M4. Approved-after-expiry changes the effective credential pickup deadline to retention, but lifecycle and recovery are not specified

**Defect.** The advertised `expires_in` ceases to be the credential pickup deadline once approval wins: credentials remain retrievable until an implementation-specific retention sweep. That expands the bearer-secret exposure/pickup window and makes security behavior depend on adapter retention. After sweep, polling returns `invalid_device_code`, which the plugin treats as fatal; the plan neither specifies recovery nor tests the boundary. It also does not define whether retention is measured from `expiresAt` or approval time for a late commit.

**Evidence.** Wire documentation says the plugin must restart after expiry (`packages/saas/src/device-flow-types.ts:89-93`). The plan instead returns approved credentials until sweep (`P1-2-PLAN.md:225-230`), while sweep evicts after retention (`:161-162`, `:287-288`). The plugin throws on every error other than `authorization_pending` (`packages/plugin/src/enrollment-client.ts:410-415`). Test 15 checks only past-expiry success, not sweep/fatal/re-enroll behavior (`P1-2-PLAN.md:306-307`).

**Suggested fix.** State a public credential-pickup policy and a minimum/maximum approved-result retention contract independent of adapter defaults (ideally measured from approval commit). Update `expires_in` documentation to distinguish approval deadline from result-retrieval retention. Add tests immediately before/after sweep and an end-to-end recovery test proving the client can start a fresh enrollment after eviction, or explicitly document the fatal/manual recovery behavior.

### M5. Migration inventory is incomplete and the “four construction sites” claim understates required changes

**Defect.** The plan lists four runtime consumers and one boundary test but omits numerous test construction sites and direct imports that will fail when both memory classes and `EnrollmentStore` are deleted. It also says the real e2e scripts should be unchanged without identifying the actual package scripts/harnesses that construct or compile affected consumers.

**Evidence.** Repository-wide search finds affected files beyond the four consumers: `packages/saas/src/device-flow-enrollment.test.ts`, `agent-key-registry-v2-integration.test.ts`, `agent-key-registry.test.ts`, `nats-user-jwt.test.ts`, `external-nats-account.test.ts`, `nats-permissions-realserver.test.ts`, `p1-1-http-ui-contract.test.ts`, and `packages/plugin/src/enrollment-client.test.ts`, in addition to the files named by the plan. For example, `agent-key-registry-v2-integration.test.ts:3-27` imports both deleted SPIs and builds services from them; `nats-user-jwt.test.ts:11-23` directly constructs the deleted registry. The plan inventories only four construction sites (`P1-2-PLAN.md:248-260`) and describes an unspecified “run-all-real.sh family” (`:322-324`).

**Suggested fix.** Add a checked migration matrix generated from `rg`, covering source, unit/integration tests, docs, package exports, type tests, and every build/e2e command. State whether registry-only conformance tests use a repository instance or an internal non-exported fixture. Name the exact package scripts/harness paths to run and include full workspace typecheck/build so stale direct imports cannot hide.

### M6. The conformance suite cannot demonstrate several claimed guarantees as currently designed

**Defect.** Running scripted `Promise.all` operations against synchronous Map RMW mostly proves JavaScript run-to-completion, not the durable fault and interleaving semantics promised to integrators. “Observe enrollment and registry in one snapshot” is impossible through two separate public reader calls; a transition can occur between them. There is no clock injection, crash/timeout injection contract, or way to force a read/mint/commit boundary in the synchronous memory implementation. Thus the suite cannot pin linearization, ambiguous commit, rollback after registry failure, or sweep-vs-commit as claimed.

**Evidence.** The memory reference explicitly relies on await-free synchronous RMW (`P1-2-PLAN.md:108-110`), and the current memory registry does the same (`packages/saas/src/agent-key-registry.ts:58-61`). The suite promises “whole-interval” invariants and a joint snapshot (`P1-2-PLAN.md:183-190`, `:275-277`) despite exposing only separate `getEnrollment` and `getActive` methods (`:143-153`). Integration tests mention unspecified fault-injection hooks (`:292`), but no adapter factory, clock, barriers, or failure model is designed.

**Suggested fix.** Specify an exported conformance harness API with adapter factory/reset/close, controllable repository clock, and optional operation barriers/failpoints. Test externally observable histories/outcomes rather than claiming an unavailable cross-reader snapshot, or add a diagnostic atomic snapshot method used by conformance. Include adapters that simulate commit-before-response failure and registry-substep rollback. Require integrator suites to run against the actual shared backend from independent clients/processes, not merely one JS object.

## MINOR

### m1. The current-code description is mostly correct, but one stated line behavior is overbroad

**Defect.** The plan says poll/approve/deny expiry writes can overwrite an approved record. That is true for unlocked `poll`, but current `approve` and `deny` share the per-user-code lock and re-read inside it; their own expiry writes cannot race one another on the same service instance. The multi-replica/store race remains real, so the defect is wording, not the need for conditional transitions.

**Evidence.** Current order is indeed gate → mint → register → store → verify (`packages/saas/src/device-flow-enrollment.ts:761-798`), validating §0.1. Poll unconditionally expires its previously read record without the lock (`:611-620`). Approve and deny both use `withUserCodeLock` (`:678-713`, `:813-825`). The plan groups all three writes together as capable of overwriting approved (`P1-2-PLAN.md:76-83`).

**Suggested fix.** Qualify the claim: poll can race approval even in one process; approve/deny expiry writes become unsafe across replicas or non-shared lock domains. Preserve the conditional-transition fix and correct the cited current line references after implementation rebases.

### m2. Poll's stale-read response rule is ambiguous after `tryExpire`

**Defect.** Poll reads a record, calls boolean `tryExpire`, then says the response is based on “state.” It does not say whether that means the stale pre-transition record, the boolean outcome, or a re-read. A successful expiration followed by stale `pending`/`approving` dispatch could return `authorization_pending` once after terminal expiry.

**Evidence.** Proposed flow is at `P1-2-PLAN.md:225-232`; `tryExpire` returns only boolean (`:159-160`). The plugin retries only `authorization_pending` (`packages/plugin/src/enrollment-client.ts:410-415`), so this is observable.

**Suggested fix.** Make `tryExpire` return a discriminated current-state outcome or re-read after a failed/successful transition, then define one linearizable response. Add expire-vs-commit and expire-vs-reclaim response tests, not only final-state tests.

## Verdict

NEEDS_CHANGES
