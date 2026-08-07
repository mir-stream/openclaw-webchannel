# Issue #81 — Session liveness recovery — Implementation Plan (v2)

> Status: **REVIEW-READY PLAN REVISION v2 — decisions frozen, implementation not started.**
> Issue: `#81 Gateway restart silently and permanently mutes every live browser session`
> Branch: `mir-stream/issue-81`
> Chosen implementation slice: **client-only reactive v1**; no plugin or wire-contract change.
> Evidence references were checked against the current branch HEAD on 2026-08-07.

---

## 1. Outcome and acceptance boundary

When an already-sent `user_message` receives no owned application result for 30 seconds
while the NATS transport still appears healthy, the client trips the current episode's
recovery allowance. It marks the
application connection as `reconnecting`, calls the raw client's **public**
`this.client.reconnect()` exactly once for that episode, re-runs the existing registration
path, and replays the existing ledger with unchanged wire IDs. The wrapper does not expose
`connected` again until `onSession` proves that registration and key establishment
succeeded.

This v1 is deliberately reactive. It makes the next attempted send recover after a gateway
restart or peer eviction and makes an unavailable agent visible in connection status. It
does not detect an idle muted tab, add an application probe, or decide that a missing ACK
means the turn was not delivered.

Acceptance criteria:

1. A healthy relay that continues to answer raw NATS `PING`/`PONG`, but whose agent no
   longer ACKs a tracked send, triggers one public soft reconnect at the configured elapsed
   deadline.
2. Recovery preserves the original `user_message.id`; the existing register → key →
   `flushQueue()` path owns replay.
3. All unacked receipts remain `sent` and replayable until an authenticated ACK or an
   already-existing terminal, explicit-close, overload, or ledger-overflow outcome.
4. Raw transport connectivity is not application readiness. From transport loss through
   successful registration/key establishment the wrapper reports `connected: false` and
   `status: "reconnecting"` (or `"connecting"` before the first session).
5. If the agent stays unavailable, the existing bounded registration attempt and soft
   reconnect loop continues. Status is `connecting` before the first session and
   `reconnecting` after a prior session; v1 adds no recovery-cycle ceiling or send failure.
6. Multiple stalled IDs and a simultaneous real relay drop cannot cause one liveness
   reconnect per ID or parallel liveness recovery cycles. Any non-explicit, non-terminal
   raw loss while an episode owns ledger work consumes that episode's one recovery
   allowance before session reset.
7. `ackStallTimeoutMs: 0` disables only the ACK-stall detector and preserves existing
   retry/reconnect behavior. The session-aware wrapper readiness correction still applies.

---

## 2. Verified defect mechanics

The plugin's live peer state is process memory. `peerSubscriptions` is declared in
`packages/plugin/src/nats-channel.ts:137`, `peerSessionKeys` at `:202`, and both are filled
by `registerPeer()` (`:276-313`). After a gateway restart, the browser's `.in` subject has
no subscriber and Core NATS silently discards the publish. Peer-cap eviction reaches the
same state: `registerPeer()` evicts the oldest peer at `nats-channel.ts:293-308`.

The browser does not notice because:

- `startHeartbeat()` sends a raw NATS `PING` (`packages/client/src/nats-client.ts:952-970`).
  The relay, not the agent application, answers it.
- Registration is driven by the raw connection edge: the raw state listener calls
  `onConnected()` at `nats-client.ts:1250-1253`; the register request is made at
  `:1625-1643`. A healthy socket produces no new edge.
- Published `user_message`s stay in `unackedLedger` (`:1177-1194`) and retry forever via
  `armLiveRetryTimer()` / `retryDueUnacked()` (`:2192-2239`). Backoff caps at about 30
  seconds (`:2179-2183`), but there is no application-liveness escalation.
- The wrapper currently maps raw `onState(true)` directly to public `connected` at
  `packages/client/src/nats-client-wrapper.ts:217-247`, even though its session key is not
  established until `onSession` (`:249-263`). That creates a false-ready interval after a
  reconnect.

ACK is a useful reactive reachability proof because it is an encrypted inbound application
frame and is emitted at ingress admission, not at turn completion. `deliverInbound()`
decrypts before `drainAcked()` (`nats-client.ts:1530-1559`); plugin ingress ACK and duplicate
ACK behavior is pinned in `packages/plugin/src/ingress-dedupe.test.ts:570-668`.

### Credential scope correction

Browser NATS grants are peer-scoped, not tenant-wide:
`packages/saas/src/nats-user-creds.ts:171-172` grants
`webchannel.${tenant}.*.${peerId}.>`. The comment at
`packages/client/src/nats-client.ts:1628-1630` is stale and must be corrected. The current
register reply inbox works because `…${accountId}.${peerId}.reginbox` remains inside that
peer subtree, not because the browser has `webchannel.${tenant}.>` access.

---

## 3. Frozen design decisions

| Decision | Frozen v1 choice | Reason |
|---|---|---|
| Detection signal | Elapsed wall time in one continuous no-owned-result interval | The interval starts at the first successful publish; an owned ACK/rejection starts a fresh interval for remaining ledger work. It is independent of retry count and jitter. |
| Threshold | Public high-level `ackStallTimeoutMs?: number`, default `30_000`; `0` disables | Accept integers `0..2_147_483_647` only. This is a recovery policy, not a correctness bound, aligned with the existing 30 s retry cap (`nats-client.ts:2179-2183`) and wrapper stale-draft grace (`nats-client-wrapper.ts:184`). |
| Watchdog recovery call | At most one per continuous episode: a watchdog trip makes exactly one `this.client.reconnect()` call; an unrelated raw loss consumes the allowance without a second watchdog call | Uses the supported soft-reconnect boundary at `nats-client.ts:904-916`; higher-level code must never call private `forceReconnect()` (`:987`). |
| Episode end | An authenticated ACK or overloaded rejection that matches at least one currently ledgered ID, explicit `disconnect()`, or terminal teardown | An owned application result proves the agent processed this client's ingress. Raw PONG, unknown ACK, and successful registration alone do not prove the stalled send path. |
| Receipt policy | No liveness-specific failure | Missing ACK is delivery-unknown, not proof of non-delivery. Keep existing `SendFailure` and `trackerFail()` behavior unchanged. |
| Persistent outage | Existing transient-register retry loop | `registerWithPop` remains bounded per attempt; `onConnected()` already calls public `reconnect()` after transient exhaustion (`nats-client.ts:1672-1685`). Status is `connecting` before the first successful session and `reconnecting` afterward. No v1 cycle ceiling. |
| Idle tabs | Follow-up, not v1 | Reactive ACK detection requires a send. Preferred long-term solution is an authenticated application probe with an agent instance epoch. |

The 30-second default is an operational recovery policy, not a delivery timeout. It does
not fail a receipt or claim that delivery took less than 30 seconds. Deployments with
unusually high ingress-result latency can raise it; deployments that do not want reactive
recovery can set it to zero.

---

## 4. State model and invariants

### 4.1 Per-client no-result age

Add episode metadata to `WebChannelNatsClient`, conceptually
`ackStallSinceAt: number | null` plus `ackStallRecoveryIssued: boolean`. The first
successful raw publish of a ledgered `user_message` starts `ackStallSinceAt` if it is null.
Later sends, retries, and session replay do not move it while no owned result arrives. A
send that never successfully writes is already handled by transport reconnect and does not
start an application-result clock.

Per-client placement is load-bearing. `flushQueue()` copies ledger messages into
`outboundQueue`, clears the ledger, and reseals them (`nats-client.ts:1863-1876`). Ledger-
only `firstAttemptAt` would be lost by that cycle and could postpone detection forever.
The episode fields survive that clear/reseal and coalesce many unacked IDs into one
continuous no-result interval.

The successful-first-publish transaction is exact. `seal()` already captures `attemptAt`
before calling raw `publish()` (`nats-client.ts:1971-1999`). Reuse that value: immediately
after `publish()` returns `true`, execute `ackStallSinceAt ??= attemptAt` **before**
`trackerAdvance(id, "sent")` or timer scheduling. Do not call `retryNow()` again. The
tracker transition invokes public synchronous send-state listeners, and the injected clock
and scheduler are also synchronous callouts; no episode mutation may trail those callouts.

### 4.2 Per-client recovery episode

The recovery-issued field is the per-`WebChannelNatsClient` latch:

```ts
private ackStallRecoveryIssued = false;
```

Timer cancellation has its own reentrancy contract. Change `cancelLiveRetryTimer()`
(`nats-client.ts:2185-2189`) to increment the generation, capture the current timer handle,
and set `liveRetryTimer = null` **before** invoking injected `retryClearTimeout(handle)`.
The clear hook is a synchronous callout and may re-enter disconnect/connect. It must always
observe that the old handle is no longer owned by the client.

Its invariants are:

- `false → true` is committed **before** calling `this.client.reconnect()`. The commit is
  complete before a raw state listener, scheduler hook, or other synchronous callout can
  re-enter the client.
- The latch is per client, not per wire ID. One scan may find many expired IDs, but it
  performs one transition and one reconnect call.
- A non-explicit, non-terminal raw `onState(false)` (`!disconnected &&
  !terminalReached`) consumes the current episode's recovery
  allowance whenever `ackStallSinceAt !== null` and `unackedLedger` is nonempty. In
  `WebChannelNatsClient`'s already-registered raw state handler
  (`nats-client.ts:1250-1253`), set `ackStallRecoveryIssued = true` atomically **before**
  `resetSession()` or any downstream callback. A real socket loss is already a recovery
  attempt and must not be followed by a watchdog-driven second socket replacement.
- `resetSession()` must not clear it. A reconnect immediately invokes raw state callbacks,
  and `resetSession()` currently cancels the retry timer and clears the key
  (`nats-client.ts:1497-1509`). Clearing the latch there would allow another ID to create a
  reconnect storm after the replacement session.
- A successful `onSession` also does **not** clear it. If registration succeeds but no
  matching ACK arrives, v1 does not retrigger another liveness reconnect for the same
  episode. Same-ID replay already happened, and repeated reconnects would add churn without
  adding evidence.
- An authenticated ACK or overloaded rejection resets the episode only when at least one
  deduplicated frame ID was ledger-owned at entry. Unknown/late IDs do not count. The exact
  result transaction is specified in §4.3.
- Explicit `disconnect()` and terminal teardown clear **both** episode fields. Put this in
  `takePendingSendIds()` (or an exact equivalent): first detach queue/ledger ownership,
  then set `ackStallSinceAt = null` and `ackStallRecoveryIssued = false`, then call the
  reordered cancellation helper, and finally return IDs for failure callbacks. A single
  JavaScript stack means the timer cannot fire between detachment and cancellation; if the
  injected clear hook re-enters, it sees retired ownership, cleared episode metadata, and
  a null timer handle before any failure listener runs.

If a genuine relay drop races the deadline, either ordering consumes the same allowance.
The detector commits the latch before public `reconnect()`; if raw loss wins, the raw state
handler commits it before `resetSession()`. It survives replacement registration, replay,
and `onSession`, so a drop just before or at the deadline cannot re-arm an already-expired
watchdog and immediately replace the new socket while its ACK is one event-loop turn late.
Existing raw generation/epoch guards still decide which registration continuation wins
(`nats-client.ts:1597-1601`, `:1644-1648`, `:1687-1690`).

### 4.3 Authenticated-result transaction

Apply the same transaction shape in `drainAcked()` and `drainRejected()`:

1. Deduplicate frame IDs and snapshot `ownedResult = frameIds.some(id =>
   unackedLedger.has(id))` before deletion.
2. Capture guards for the current live lifecycle: `connectionEpoch`, the current
   `sessionKey` identity, and disconnected/terminal state.
3. Delete **all** frame IDs from the ledger, then call the reordered live-timer cancellation
   helper. `retryClearTimeout` is the first possible callout: it receives a captured handle
   after the instance handle was nulled and may re-enter lifecycle methods. This preserves
   the existing authoritative whole-frame detach rule without falsely claiming cancellation
   itself is callout-free.
4. After cancellation returns, keep every episode write behind the captured lifecycle
   guards. If `ownedResult` and the ledger is now empty, do **not** invoke `retryNow()`;
   guarded-clear `ackStallSinceAt` and `ackStallRecoveryIssued` directly. If owned work
   remains, invoke injected `retryNow()` and, only if the epoch/session/disconnected/
   terminal guards still identify the same live lifecycle afterward, start a fresh interval
   at `resultAt` with `ackStallRecoveryIssued = false`. If the clear hook or clock changed
   lifecycle, do not overwrite teardown or replacement-lifecycle state.
5. Apply authoritative tracker transitions to every detached frame ID even if `retryNow()`
   or an earlier tracker listener changed lifecycle: ACK advances to `accepted`; rejection
   keeps the existing `failed{overloaded}` path. These results belong to the detached
   authenticated frame.
6. Call the trailing `armLiveRetryTimer()`; its existing session/disconnected/terminal and
   generation guards make it a no-op for a retired lifecycle.

This ordering covers three reentrancy seams: an injected `_retryClearTimeout` that
disconnects during cancellation, an injected `_retryNow` that disconnects during result
reset, and an `onSendState` listener that disconnects at the first result transition. None
may leave stale episode fields or a timer on the retired lifecycle.

### 4.4 Why there is no N-cycle ceiling in `retryDueUnacked`

`retryDueUnacked()` cannot own a recovery-cycle counter. Its timer requires a session key
(`nats-client.ts:2194`), while the reconnect edge runs `resetSession()`, which cancels that
timer and nulls the key (`:1497-1499`). If the agent stays unavailable, registration
attempts happen in `onConnected()` and fail before any new live retry timer exists. A
counter advanced only by `retryDueUnacked()` therefore cannot reach a ceiling; it either
stops after the first reconnect or is accidentally reset and storms.

V1 does not invent a second registration-lifecycle counter. Each register attempt remains
bounded by `registerWithPop`; transient exhaustion follows the existing public soft-
reconnect loop at `nats-client.ts:1672-1685`. The public wrapper remains visibly
`connecting` before its first authenticated session or `reconnecting` after a prior one.

---

## 5. Detection and scheduling algorithm

Add `ackStallTimeoutMs` to the public high-level `WebChannelNatsClientOptions` at
`packages/client/src/nats-client.ts:276`, **not** raw `NatsClientOptions` at `:64`: raw
`NatsClient` does not consume this application-level policy. Default to `30_000`. Accept
only integer values in `0..2_147_483_647`; reject negative, greater-than-max, non-finite,
and non-integer inputs in the high-level constructor. The upper bound is the portable
32-bit timer maximum. Node clamps oversized `setTimeout` delays to about 1 ms, which would
turn a permissive large value into a reconnect storm rather than a long timeout.

With the detector enabled, `armLiveRetryTimer()` computes remaining delays, not an unsafe
absolute `since + timeout`:

1. `retryRemaining = max(0, earliestNextRetryAt - now)` when a retry exists;
2. `elapsed = max(0, now - ackStallSinceAt)` and
   `stallRemaining = max(0, ackStallTimeoutMs - elapsed)` when the episode owns ledger work
   and recovery has not been issued; and
3. schedule `min(retryRemaining, stallRemaining)` across the available values.

All scheduled values are therefore within the timer maximum. Computing the minimum is
essential: the retry delay reaches 30 seconds, so checking only at the next retry can
overshoot a shorter configured stall deadline. `0` omits the detector delay entirely.

At the start of `retryDueUnacked()`:

1. Re-check session/disconnected/terminal guards.
2. Read `now` once and use elapsed subtraction, never absolute deadline addition.
3. Before sealing or publishing a retry, check whether the current no-result episode has
   reached its deadline and the recovery-issued latch is false.
4. If so, set the per-client latch to true, cancel/retire this retry timer generation, call
   `this.client.reconnect()` once, and return. Do not retry-publish or re-arm after the
   callout; reconnect/reset/session establishment owns subsequent scheduling.
5. Otherwise execute the existing due-retry loop and re-arm using the minimum rule above.

The latch mutation precedes the reconnect callout because `reconnect()` synchronously
notifies raw state listeners through `forceReconnect()` (`nats-client.ts:987-1013`). The
existing disconnected/terminal and timer-generation checks remain mandatory around
injected scheduler callouts (`:2201-2218`). No independent liveness timer or third
generation counter is added.

---

## 6. Recovery and replay path

The detector calls `this.client.reconnect()`, the public method at
`packages/client/src/nats-client.ts:913-916`. It must never reach through to private
`forceReconnect()`.

The existing path then supplies all recovery mechanics:

1. Raw soft reconnect tears down and redials.
2. Raw `onState(true)` invokes `onConnected()` (`nats-client.ts:1250-1253`).
3. `onConnected()` replaces the `.out` subscription before registration
   (`:1604-1612`).
4. Existing PoP registration re-establishes plugin peer state and installs an authenticated
   conversation key (`:1625-1793`).
5. `flushQueue()` moves the unacked messages to the front and reseals them with the same
   wire IDs (`:1863-1876`). Existing plugin ingress dedupe prevents a second turn and ACKs
   duplicate IDs (`packages/plugin/src/ingress-dedupe.test.ts:621-647`).

No plugin file, NATS subject, envelope, ACK shape, `SendFailure.reason`, or receipt state is
changed.

### Peer-cap limitation

At a full `maxPeers` cap, re-registering the evicted peer may evict the then-oldest other
peer. If that peer later sends, it can in turn recover and evict another peer: a peer-cap
carousel. V1 therefore provides a **bounded, recoverable attempt for the active sender**,
not complete global self-healing or stable convergence under sustained full-cap churn.
Changing the cap policy, adding leases, or persisting registrations is outside #81 v1.

---

## 7. Wrapper application-readiness contract

`WebChannelNATSClient` already starts with `status: "connecting"` and
`connected: false` (`packages/client/src/nats-client-wrapper.ts:92-101`). Add a private
`everSessionEstablished` boolean and make state transitions session-aware:

| Event | Before any successful session | After any successful session |
|---|---|---|
| raw `onState(false)` | `connecting`, `connected: false` | `reconnecting`, `connected: false` |
| raw `onState(true)` | remain `connecting`, `connected: false` | remain `reconnecting`, `connected: false` |
| `onSession` | `connected`, `connected: true`; set `everSessionEstablished` | `connected`, `connected: true` |
| terminal error | existing sticky `error`, `connected: false` | same |

Raw `onState(true)` is transport availability only. It must not clear an error, claim
readiness, or open the wrapper's send-release gate. `onSession`, which fires after key
installation and `flushQueue()` (`nats-client.ts:1781-1793`), is the sole non-terminal
transition to public `connected`.

Reentrancy ordering:

- On raw false, commit `sessionEstablished = false`, clear connection-scoped watches, and
  commit the public non-ready state before listener notification.
- On session success, first guard terminal/closed state, then commit
  `sessionEstablished = true` and `everSessionEstablished = true`, then set public
  `connected`. Because `setState` is an embedder callout, re-check terminal/closed and the
  session flag before arming the stale-draft watch or releasing held work. A listener that
  synchronously closes the client must not be followed by stale `maybeRelease()` work.
- Repeated raw true/false callbacks are idempotent with respect to readiness; they cannot
  promote status without a new `onSession`.

This change also makes the persistent registration loop observable: every redial may reach
raw PONG, but the UI stays `connecting` before the first session or `reconnecting` after a
prior session until registration and authenticated key establishment complete.

---

## 8. Exact implementation scope and sequence

Expected files:

| Category | File | Required change |
|---|---|---|
| Production | `packages/client/src/nats-client.ts` | Add/validate `ackStallTimeoutMs` on `WebChannelNatsClientOptions` only; reorder cancellation to null the handle before its injected clear hook; add episode state and exact mutation ordering; minimum-remaining scheduling; raw-loss allowance consumption; one public reconnect trip; owned-result/teardown reset; correct stale credential comment. |
| Production | `packages/client/src/nats-client-wrapper.ts` | Explicitly forward `ackStallTimeoutMs` in `natsOptions`; separate raw transport state from session readiness; guard reentrant `onSession` work. `WebChannelNATSClientOptions` inherits the field through `DirectClientOptions`. |
| Unit test (new) | `packages/client/src/nats-client-agent-liveness.test.ts` | Detector, validation boundaries, episode, replay, raw-loss race, result-callout reentrancy, and timer tests using `FakeNatsWS`. The existing `nats-client-liveness.test.ts` remains the raw heartbeat/auth suite and is untouched. |
| Unit test | `packages/client/src/nats-client-wrapper.test.ts` or focused wrapper test | Public option acceptance/forwarding and initial/reconnecting/session-ready status tests. |
| Component test | `packages/plugin/src/nats-channel-s2.test.ts`, `packages/plugin/src/ingress-dedupe.test.ts` | Compose/retain eviction, re-register, same-ID dedupe, and duplicate-ACK contracts; no plugin production change. |
| Live harness | `e2e/local/run-all-real.sh`, `e2e/local/all-real.mjs`, `packages/client/src/browser-jwt-entry.ts`, `e2e/local/README.md` | Add the opt-in `WEBCHANNEL_SCENARIO=agent-restart` persistent-browser restart scenario and document prerequisites. |

Explicitly unchanged: `packages/client/src/types.ts` send-failure unions,
`packages/plugin/**` production code, SaaS credentials, NATS parser, wire protocol, demo UI.
Plugin tests may be extended only to compose existing eviction/re-register/dedupe contracts;
they must not require a production plugin change.

Implementation order:

1. Add failing client tests for a healthy raw relay with no application ACK and for exact
   stall-deadline scheduling.
2. Add the option to high-level `WebChannelNatsClientOptions`, validate/default it, verify
   the public type surface, forward it through the wrapper's explicit `natsOptions` object,
   and add the per-client episode fields.
3. Reorder `cancelLiveRetryTimer()` so ownership is nulled before its injected clear hook.
   Commit episode start inside the successful-publish transaction, add raw-loss allowance
   consumption before `resetSession()`, and change `armLiveRetryTimer()` to use the minimum
   remaining delay.
4. Add the detector/latch transition at the front of `retryDueUnacked()`. Implement the
   guarded ACK/rejection reset transaction and teardown clearing; verify `resetSession()`
   and successful `onSession` preserve an already-consumed allowance.
5. Make wrapper readiness session-aware and add initial, reconnecting, success, terminal,
   and reentrant-close tests.
6. Correct the credential-scope comment.
7. Extend the real-browser harness and README, then run focused client tests, mandatory
   plugin component tests, the client suite, structural checks, and the opt-in live gate.

---

## 9. Verification matrix

### 9.1 Client `FakeNatsWS` tests

`FakeNatsWS` can prove a generic healthy-relay/no-ACK condition and wrapper readiness. It
cannot prove real plugin peer-cap eviction or plugin ingress dedupe.

| ID | Scenario | Required assertion |
|---|---|---|
| C1 | Session established; send publishes; no ACK; raw PONG remains healthy | No reconnect before 30 s; one public recovery reconnect at exactly 30 s even when next retry is later. |
| C2 | `ackStallTimeoutMs: 0` | Existing retry/reconnect behavior continues and no liveness reconnect occurs; wrapper readiness is still session-aware. |
| C2a | Option validation | Default is 30,000; `0` and `2_147_483_647` are accepted; `-1`, `2_147_483_648`, `NaN`, infinities, and fractional values throw. Public wrapper options accept and forward the field; raw `NatsClientOptions` does not advertise it. |
| C3 | Several IDs share the expired deadline | Exactly one reconnect call/socket replacement for the episode. |
| C4 | Recovery registration succeeds and ledger replays | Same IDs are republished; receipt stays `sent` until ACK, then becomes `accepted`. |
| C5 | `flushQueue()` clears/reseals ledger | Per-client episode start survives; the deadline is not restarted. |
| C6 | New session succeeds but still no ACK | No second liveness reconnect in the active episode. |
| C7 | Matching encrypted ACK or overloaded rejection after recovery | Episode resets; remaining ledger work gets a fresh 30 s no-result interval and may start one new episode. Unknown ACK does not reset it. |
| C8 | Raw close wins just before/at deadline; replacement registration succeeds; ACK is delayed one event-loop turn | Raw false consumes the episode allowance before reset; exactly one socket replacement occurs and the replacement is not immediately replaced by the expired watchdog. |
| C9 | Explicit disconnect or terminal register result | Episode clears/retired state never redials; existing receipt terminal behavior remains authoritative. |
| C10 | First successful `sent` tracker listener disconnects | Episode start was committed from the captured `attemptAt` before the listener; teardown clears it and leaves no timer. |
| C11 | Owned ACK/rejection invokes an injected `_retryNow` that disconnects | Whole frame is detached, tracker results remain authoritative, stale result-reset state does not overwrite teardown/replacement state, and no timer survives. |
| C12 | Injected `_retryClearTimeout` re-enters `disconnect()` during result cancellation and explicit/terminal retirement | Timer handle is already null. Teardown exposes detached ownership and cleared episode state; result guards prevent stale writes; authenticated tracker result remains authoritative; no timer survives. |
| W1 | Initial raw socket opens before registration resolves | Wrapper remains `connecting`, `connected: false`. |
| W2 | Established session loses raw transport; replacement raw socket opens | Wrapper remains `reconnecting`, `connected: false` until replacement `onSession`. |
| W3 | Replacement registration gets transient 503/exhaustion | Raw reconnect loops while wrapper never flashes connected. |
| W4 | State listener closes synchronously during session-ready notification | No stale watch/release work and no ready-state revival. |

The injected quartet `retryNow`, `retryRandom`, `retrySetTimeout`, and
`retryClearTimeout` (`nats-client.ts:1201-1204`) controls the live-retry scheduler only.
It does **not** control raw reconnect timers or raw request timeout timers.
`registerWithPop` has bounded attempts but no explicit retry sleep. Deterministic tests
must therefore use the injected clock
for deadline math plus Vitest fake global timers for raw reconnect/request activity. Where
the test needs registration failure, make the harness return a synchronous 503 response
instead of waiting for a real 5-second request timeout; synchronous 503s can exhaust the
bounded register attempts immediately. Advance raw reconnect/request timers explicitly.
Do not assume the scheduler quartet makes the whole connection lifecycle deterministic.

### 9.2 Plugin component composition

Use the existing component surfaces rather than claiming a client fake emulates the
plugin:

- extend/compose `packages/plugin/src/nats-channel-s2.test.ts:42-80` to prove cap eviction
  tears down the evicted peer and re-registering that peer restores its subscription while
  remaining bounded;
- retain `packages/plugin/src/ingress-dedupe.test.ts:570-668` as the authority that same-ID
  replay is ACKed but not dispatched twice;
- if a single composed test is practical, connect these two existing contracts at the
  component level. Otherwise cite both passing tests as the composition evidence. Do not
  label either as end-to-end self-healing.

### 9.3 Regression and live gates

Run at minimum:

```sh
npm test --workspace packages/client -- nats-client-liveness.test.ts
npm test --workspace packages/client -- nats-client-agent-liveness.test.ts
npm test --workspace packages/client -- nats-client-wrapper.test.ts
npm test --workspace packages/plugin -- nats-channel-s2.test.ts ingress-dedupe.test.ts
npm test --workspace packages/client
npm run typecheck
```

The first command above keeps the existing raw heartbeat/auth liveness suite unchanged; the
new application-liveness work belongs in the distinct agent-liveness file. Unit and plugin
component tests are mandatory even when local live-harness prerequisites are unavailable.

The live acceptance gate is an explicit repository harness mode:

```sh
WEBCHANNEL_SCENARIO=agent-restart bash e2e/local/run-all-real.sh
```

Extend the existing harness as follows:

1. `run-all-real.sh` reuses the setup and prerequisites documented in
   `e2e/local/README.md`. In `agent-restart` mode it keeps real NATS, issuer, echo model,
   page server, and one persistent browser/client alive. Create a scenario control
   directory under the harness's isolated `$OCH`; pass its path plus
   `WEBCHANNEL_SCENARIO` to `all-real.mjs`; start the driver in the background and add its
   PID to cleanup. The driver writes a `browser-ready` record after the positive control,
   waits for a shell-written `gateway-restarted` release record, and writes final JSON for
   the shell to validate before waiting on its exit status.
2. After the browser establishes a production `WebChannelNATSClient` wrapper session and completes
   a positive-control exchange, the shell kills the exact tracked `GW_PID`, waits for that
   process to exit, and restarts the **same** gateway command with the same HOME, config,
   ports, and environment. Use a fresh restart log (or record the old log byte offset) so
   readiness cannot match the old process. It waits for a new structured
   `event=webchannel.account_aggregate ... state=complete` readiness record from the new
   process, then atomically creates `gateway-restarted` to release the browser's second
   phase. NATS, issuer, and browser are never restarted.
3. `all-real.mjs` and `browser-jwt-entry.ts` implement a two-phase coordination seam so the
   page and one wrapper instance stay open across the shell-controlled restart. Expose
   page-side start/continue scenario functions backed by that retained instance; the Node
   driver calls start, writes `browser-ready`, waits for the shell release, then calls
   continue. The browser uses the production
   public wrapper with a shorter explicit `ackStallTimeoutMs` suitable for the harness,
   sends only after the new gateway readiness record, and records public status trace, the
   second-phase user bubble's original wire ID, receipt-state trace, reply texts/count, and a
   detector-driven socket-replacement count. Install a page-init WebSocket constructor
   counter before the client bundle and assert the stalled-send phase adds one socket; do
   not expose a production diagnostic solely for this test.
4. Assert initial/replacement raw connectivity stays `connecting`/`reconnecting` until
   `onSession`; exactly one detector-driven new WebSocket occurs; the phase-2 bubble's
   public `wireId` is captured once and remains unchanged through its `accepted` receipt;
   and exactly one phase-2 logical agent turn/reply is observed (the positive-control
   baseline has its own separate reply). Do **not** attribute or count ciphertext
   retransmissions in this live test: C4 and the ingress-dedupe component tests separately
   prove same-ID republish and one logical dispatch, while the normal live-retry loop may
   publish that ID more than once before recovery.

A client-only fake is not a substitute for this live gate, but absence of the external
runtime prerequisites may be reported separately after all mandatory unit/component gates
pass.

---

## 10. Alternatives and follow-ups

| Alternative | Coverage | Cost / limitation | Disposition |
|---|---|---|---|
| ACK stall → full socket reconnect (this plan) | Reactive restart and active evicted-peer recovery | One redial and redundant register snapshots; no idle detection | **Chosen v1:** smallest client-only change that reuses authenticated ACK, registration, and same-ID replay. |
| ACK stall → in-place re-register | Same reactive coverage | Requires splitting and synchronizing registration/key installation against live sends | Rejected for v1; higher race surface than existing reconnect path. |
| Focus/interval unconditional re-register | Some proactive idle coverage | Normal sessions repeatedly pay PoP and snapshot churn; focus misses background outbound loss | Not chosen. |
| NATS `no_responders` | Fast missing-subscription hint | Requires `HPUB/HMSG` support in the hand-written parser and does not prove key/handler health | Defer until parser issue #48 is resolved; at most a future fast hint. |
| Persist/lease peer registrations | Proactive restart recovery | Requires TTL, stale-peer cleanup, revocation, and cap-policy design | Separate plugin/storage project. |
| Startup broadcast | Restart only | Browser credentials cannot subscribe to a shared subject; relay-authentication problem | Rejected. |
| Authenticated probe + agent instance epoch | Proactive idle, restart, and eviction detection | New client/plugin/wire contract and coordinated deployment | **Preferred long-term solution.** Probe inside the peer subtree; authenticate the reply with the established key or pinned agent identity; epoch changes force re-registration. |

Follow-up scope is explicit, not an implementation decision for v1:

- idle-tab and agent-initiated outbound liveness;
- authenticated application probe plus per-process `instanceEpoch`;
- a product-level finite `delivery-unknown` / degraded / manual-retry policy, if desired;
- peer leases or a fairer cap policy to prevent full-cap carousel behavior.

Until such a delivery policy exists, ACK absence must not call `trackerFail()` or add a
misleading `unreachable` reason: the agent may have admitted the original message and only
the ACK may have been lost.

---

## 11. Non-goals and guardrails

- No finite liveness escalation counter or N-cycle ceiling.
- No new receipt state, `SendFailure.reason`, `WebChannelErrorCause`, or demo rendering.
- No private `forceReconnect()` call from `WebChannelNatsClient`.
- No plugin production change, new subject, header parser work, credential broadening, or
  protocol version bump.
- No claim that one active peer's recovery stabilizes all peers at a saturated cap.
- No claim that a raw PONG proves application readiness.
- No real-time sleeps in deterministic unit tests.

Related work: #48 (wire parser / `no_responders` prerequisite), #57 (busy-turn behavior),
#72/#84 (credential containment), and #51 (registration-state lifecycle family).
