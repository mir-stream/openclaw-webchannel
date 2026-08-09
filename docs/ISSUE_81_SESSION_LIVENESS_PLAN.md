# Issue #81 — Session liveness recovery — Concise implementation plan

> Status: **implementation-ready; decisions frozen, implementation not started.**
> Branch: `mir-stream/issue-81`
> Scope: client-only reactive v1; no plugin production or wire-contract change.
> The former v3 transaction-by-transaction design remains available in Git history. This
> document is the execution contract.

## 1. Outcome and scope

Gateway restart or peer eviction can remove the agent's in-memory peer subscription and
session key while the browser's NATS socket remains healthy. Raw `PING`/`PONG` therefore
proves relay transport only; it does not prove that the gateway application can receive the
browser's messages.

V1 recovers the two active-work cases that can wedge a live browser:

1. a `user_message` was published but receives no owned application ACK/rejection; and
2. an ordinary follow-up remains locally held behind a live-turn/FIFO gate and receives no
   authenticated turn activity.

Both cases request the existing public soft reconnect once per continuous stall episode.
The established reconnect -> register -> key -> ledger replay -> `onSession` path performs
the recovery.

Acceptance boundary:

- preserve every published message's original wire ID across replay;
- keep delivery-unknown receipts `sent` and replayable until an existing authoritative
  result occurs;
- never fail, retract, `/stop`, auto-release, or mint a wire ID for held work from a
  liveness detector;
- report public `connected: true` only after registration, key establishment, and replay;
- coalesce published, held, and genuine raw-loss recovery into one socket replacement;
- keep persistent registration retry behavior and add no recovery-cycle ceiling;
- do not attempt to detect a completely idle muted tab in v1.

## 2. Existing recovery assets

The implementation should compose existing behavior rather than create a second recovery
stack:

- `WebChannelNatsClient.unackedLedger` already retains published `user_message`s and
  `flushQueue()` replays them with the same ID after registration
  (`packages/client/src/nats-client.ts:1177-1194`, `:1863-1876`).
- `NatsClient.reconnect()` is the supported soft-reconnect boundary
  (`nats-client.ts:904-916`). Higher layers must not call private `forceReconnect()`.
- `onConnected()` already re-subscribes, registers, installs the authenticated key, replays,
  and then emits `onSession` (`nats-client.ts:1580-1793`).
- The wrapper already owns held FIFO work and the post-reconnect stale-draft release path
  (`packages/client/src/nats-client-wrapper.ts:564-758`).
- Plugin ingress outcomes already provide same-ID durable dedupe. #81 verifies this contract
  with component tests but changes no plugin production code.

## 3. Frozen behavior contract

### 3.1 Public timeout

Add `ackStallTimeoutMs?: number` to high-level `WebChannelNatsClientOptions`; the exported
`WebChannelNATSClientOptions` inherits it. Do not add it to raw `NatsClientOptions`.

- default: `30_000` ms;
- accepted values: integers `0..2_147_483_647`;
- all other values: rejected synchronously by the inner constructor, never clamped or defaulted;
- `0`: disables both automatic liveness lanes without changing manual/raw reconnect,
  ordinary retries, or session-aware readiness;
- one inner-client resolved value is authoritative for both lanes. The wrapper forwards the
  raw option and reads that resolved value; it does not independently validate or default it.

The timeout is a recovery policy, not a delivery deadline. A legitimately silent long turn
with held follow-up work may incur one redundant soft reconnect. Deployments can raise the
value or set it to `0`.

### 3.2 Published-work lane

- The episode is per client, not per wire ID.
- Start its age only after the first successful raw publish of a ledger-owned
  `user_message`.
- Later sends, retries, reseals, and reconnect replay do not move the start while no owned
  result arrives.
- At the threshold, if ledger ownership remains, consume one allowance and request one soft
  recovery.
- An authenticated ACK or overloaded rejection resets the episode only if at least one
  frame ID was ledger-owned at frame entry. Unknown/late IDs and raw PONG do nothing.
- If ledger work remains after an owned result, give the remaining work one fresh interval.
- A genuine non-explicit, non-terminal raw loss consumes the active allowance before session
  reset. Successful registration or `onSession` alone does not grant another allowance.
- Explicit close and terminal teardown retire all episode and timer state.

### 3.3 Held-work lane

- An ordinary non-abort send held behind a live turn stays `queued` and has no wire ID until
  the existing FIFO release path publishes it.
- The first held owner in an authenticated ready session starts one wrapper episode. Later
  held sends join without moving its age.
- Before reducing an inbound frame, authenticated `typing`, `progress`, `reasoning`, or
  `agent_message` activity resets age and allowance only when held ownership and the
  pre-frame live-turn predicate are both present. These frame types may omit IDs; the
  wrapper's single live-turn latch is the authority.
- History, commands, approvals/snapshots, ACK/rejection, `turn_settled`, raw PONG, and
  `onSession` are not held-activity resets.
- At expiry, consume one allowance and request the same soft recovery. The detector does not
  alter held ownership or receipt state.
- Raw loss consumes and cancels the held allowance before public state callbacks. A hold
  beginning while non-ready records recovery as already in progress and arms no parallel
  timer.
- Removing the last held owner through normal release, retract, `/stop`, close, or terminal
  failure clears the episode and timer before callbacks.
- Existing settlement and stale-draft logic remains the only authority that releases FIFO
  work after replacement readiness.

### 3.4 Shared recovery and readiness

Add package-internal `WebChannelNatsClient.requestApplicationRecovery()` for both lanes. It:

- works when an ACK episode exists and when only wrapper-held work exists;
- refuses explicitly closed or terminal lifecycles;
- retires current live scheduling before recovery; and
- calls only raw public `NatsClient.reconnect()`.

The first watchdog or genuine raw-loss path commits its allowance before callbacks. Raw
`onState(false)` synchronously consumes both active lane allowances, preventing parallel
redials.

Wrapper readiness is application-session readiness, not raw transport state:

| Event | Before the first session | After a prior session |
|---|---|---|
| raw false or raw true | `connecting`, `connected: false` | `reconnecting`, `connected: false` |
| guarded `onSession` | `connected`, `connected: true` | `connected`, `connected: true` |
| terminal error | sticky `error`, `connected: false` | same |

Raw false invalidates the mid-level connection epoch before reset and callbacks. After key
installation, pending-inbound drain, and replay, `onSession` may fire only if the captured
epoch, raw connection generation, key identity, and lifecycle still match. A synchronous
replay failure must not flash ready or release held work from an abandoned session.

## 4. Mandatory hardening checklist

This checklist is normative; exact local-variable choreography is left to implementation.

- Treat injected clock/random/timer hooks, raw publish, tracker listeners, message
  listeners, and wrapper state listeners as synchronous reentrancy points.
- Commit ownership, allowance, and lifecycle mutations before callouts. After a callout,
  write only when captured lifecycle, connection/key, exact ledger ownership, episode
  generation, and timer generation remain current.
- Timer cancellation must advance an ownership token and null the instance handle before
  invoking clear. An outer armer must never overwrite or clear a timer installed by reentry.
- ACK/rejection detaches the complete deduplicated frame before tracker callbacks.
  Authoritative tracker outcomes still fan out if reentry changes lifecycle.
- A final owned result ends the old episode before a reentrant timer-clear hook. When work
  remains, commit its fresh result age before callbacks and recompute only current scheduling.
- Resolve retry randomization before sampling the successful-publish clock. A synchronous
  result or raw loss during publish wins over stale episode and retry-metadata writes.
- Schedule at `min(nextRetryDue, stallDue)` so retry backoff cannot overshoot the configured
  threshold. Disabled mode omits the stall candidate.
- No stale stack may install episode state, retry metadata, a timer, or `onSession` into a
  replacement lifecycle.

## 5. Implementation scope

| File | Required change |
|---|---|
| `packages/client/src/nats-client.ts` | Public high-level option and single resolved value; published episode; common recovery method; raw-loss/session fencing; retry-timer integration. |
| `packages/client/src/nats-client-wrapper.ts` | Forward resolved policy; held episode; session-aware public readiness; cleanup on every held-ownership path. |
| `packages/client/src/nats-client-agent-liveness.test.ts` (new) | Published recovery, arbitration, replay, option, stale-session, and representative reentrancy coverage. |
| `packages/client/src/nats-client-wrapper-agent-liveness.test.ts` (new) | Held recovery/activity/cleanup, cross-lane arbitration, and reconnect readiness. |
| `packages/client/src/nats-client-wrapper.test.ts` | Update existing raw-open and delayed-key assertions to expect public non-readiness until `onSession`. |
| `packages/client/src/nats-client-sendstate.test.ts` | Keep the exact legacy retry schedule isolated with `ackStallTimeoutMs: 0`. |
| `packages/client/src/nats-client-wrapped.test-harness.ts` | Forward the new option where focused tests use `makeClient()`, if needed. |
| `packages/client/src/index-exports.test.ts` | Prove the exported wrapper option accepts `ackStallTimeoutMs`. |
| `packages/plugin/src/nats-channel-s2.test.ts` | Compose peer eviction followed by bounded re-registration/subscription restoration. |
| `packages/plugin/src/ingress-dedupe.test.ts` | Recreate persistent outcome storage and prove same-ID accepted replay ACKs without a new lease or dispatch. |
| `packages/client/README.md`, `packages/client/CHANGELOG.md` | Document the option, shared semantics, readiness meaning, tradeoff, and non-breaking next-minor classification. |

Explicitly unchanged: plugin production code, SaaS credentials, subjects/envelopes/ACK shape,
protocol version, receipt/failure unions, demo UI, and package/version manifests. Manifest
bumps remain release-cut work.

## 6. Implementation sequence

1. Add failing focused tests for published stall, held stall, readiness, disabled mode, and
   one representative synchronous-result/timer-reentry race.
2. Add and validate the shared option; add the package-internal recovery boundary and make
   wrapper readiness depend on guarded `onSession`.
3. Implement the published lane in the existing live-retry scheduler, including owned-result
   reset, raw-loss allowance consumption, and stale-session fencing.
4. Implement the wrapper-held lane, authenticated-activity reset, cross-lane arbitration,
   and ownership-first cleanup.
5. Update existing readiness/backoff regressions, public type/docs, and the two plugin
   composition tests.
6. Run focused tests, full client/type checks, and the external Rota product gate against the
   pushed implementation SHA.

## 7. Verification gates

| Gate | Required proof |
|---|---|
| Published stall and replay | Healthy raw PONGs plus several published IDs: no recovery before the threshold, exactly one soft reconnect at expiry, same-ID replay, receipts remain `sent` until owned ACK, and successful registration alone does not redial again. |
| Result/raw-loss arbitration | Matching ACK/rejection resets remaining work; unknown ACK/rejection and PONG do not. Watchdog, held lane, and genuine raw loss interleave to one socket replacement. |
| Authenticated readiness | Initial/replacement raw open remains publicly non-ready with no key and no held release. Replay-send failure cannot emit stale `onSession`; a later genuine session can. Closing from the ready-state listener leaves no trailing watch, release, or readiness revival. |
| Held recovery | A is accepted/working and B is locally held with no wire ID. One recovery occurs at the threshold; the detector neither fails nor releases B; replacement readiness plus the existing stale-draft/FIFO path releases B once. A hold beginning non-ready spends its allowance, arms no timer, and `onSession` alone does not re-arm it. |
| Held activity and cleanup | Only authenticated live-turn frames reset the interval. Irrelevant frames do not. Final held-owner removal retires the timer before callbacks. |
| Public option and disabled mode | Default, `0`, maximum, and invalid classes are covered. With `0`, neither lane fires and the legacy retry schedule remains unchanged. Raw `NatsClientOptions` rejects the field at compile time, and the inner resolver is not barrel-exported. |
| Representative race hardening | Synchronous publish result/loss and reentrant clock/random/timer/tracker callbacks leave no stale episode, metadata, readiness event, or orphan timer. |
| Plugin composition | Re-registration restores an evicted peer subscription; persisted accepted replay ACKs the same ID without lease offer, logical dispatch, or rejection. |

Run at minimum:

```sh
npm test --workspace packages/client -- nats-client-agent-liveness.test.ts
npm test --workspace packages/client -- nats-client-wrapper-agent-liveness.test.ts
npm test --workspace packages/client -- nats-client-wrapper.test.ts nats-client-sendstate.test.ts
npm test --workspace packages/plugin -- nats-channel-s2.test.ts ingress-dedupe.test.ts
npm test --workspace packages/client
npm run typecheck
```

### External product gate

Use `mir-stream/rota-crew`, branch `test/wc-v040-product-e2e`, command
`npm run test:webchannel:product-e2e`. Pin `WC_REF` and the expected manifest to the pushed
implementation SHA.

S7 must contain two independent gateway-only phases:

1. retain the existing post-restart published-send recovery/completion case; and
2. start a bounded slow turn A, prove follow-up B is locally queued/cancellable with zero
   dispatch, signal the host, restart only the gateway, then require authenticated online
   plus B leaving pending state, exactly one B dispatch, and completed reply.

The product gate proves observable recovery. Unit tests remain authoritative for exact
status ordering, internal wire-ID absence, and race behavior.

## 8. Alternatives and non-goals

| Choice | Assessment |
|---|---|
| Published/held stall -> soft reconnect | **Chosen v1.** Client-only, reuses proven registration/replay/FIFO behavior, and covers active work without protocol changes. |
| In-place re-registration | Similar reactive coverage but must synchronize live key replacement and sends; higher race surface than reconnect. |
| Auto-release or bypass held FIFO | Faster follow-up publish but changes turn ordering and can create concurrent turns; rejected. |
| Authenticated probe plus agent instance epoch | Preferred long-term design for idle tabs and proactive detection; requires coordinated client/plugin/wire deployment. |

Out of scope for #81 v1:

- idle-tab and agent-initiated outbound liveness;
- peer persistence/leases or fair convergence at a saturated peer cap;
- `no_responders` parser work;
- finite delivery-unknown/degraded/manual-retry product policy;
- new receipt state, failure reason, protocol version, or plugin production behavior.
