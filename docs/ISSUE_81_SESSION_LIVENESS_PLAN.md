# Issue #81 — Session liveness recovery — Implementation Plan (v3)

> Status: **REVIEW-READY PLAN REVISION v3 — decisions frozen, implementation not started.**
> Issue: `#81 Gateway restart silently and permanently mutes every live browser session`
> Branch: `mir-stream/issue-81`
> Chosen implementation slice: **client-only reactive v1**; no plugin or wire-contract change.
> Evidence references were checked against the current branch HEAD on 2026-08-07.

---

## 1. Outcome and acceptance boundary

Two client-only reactive lanes use the same public `ackStallTimeoutMs`. An already-published
message with no owned ingress result, or locally held ordinary work with no authenticated
turn activity, may consume one recovery allowance after the configured interval. Both
lanes converge on package-internal `WebChannelNatsClient.requestApplicationRecovery()`,
which calls only the raw client's public soft reconnect. Registration, same-ID ledger
replay, and the wrapper's existing stale-draft/FIFO machinery own recovery; neither
detector fails, releases, aborts, or fabricates a wire ID for a receipt. The wrapper does
not expose `connected` again until `onSession` proves registration and key establishment.

This v1 is deliberately reactive. It covers an active published send and a follow-up held
behind a live-turn latch; a completely idle muted tab still needs the future authenticated
probe/epoch design. ACK absence remains delivery-unknown.

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
7. `ackStallTimeoutMs: 0` disables both automatic ACK-stall and held-work-stall recovery
   while preserving existing retries and session-aware readiness.
8. An ordinary non-abort send held behind an authenticated live turn receives no wire ID
   until the ordinary FIFO gate releases it. With no authenticated turn activity it requests
   one soft recovery at the same threshold; it is not failed, `/stop`ped, or released by the
   detector.
9. Raw loss consumes both currently active lane allowances before callbacks, so ACK and
   held-work watchdogs cannot redial in parallel. A later authenticated turn-activity frame
   may start a genuinely new held episode.

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
decrypts before `drainAcked()` (`nats-client.ts:1530-1559`). Production ingress uses the
outcome/lease branch of `createIngressOnFlush` (`packages/plugin/src/ingress-dedupe.ts:246-251`,
`:289-318`); §9.2 requires focused durable-restart replay coverage for its duplicate ACK
contract rather than treating the legacy boolean-dedupe branch as production authority.

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
| Published-work signal | Elapsed wall time in one continuous no-owned-result interval | The interval starts at the first successful publish; an owned ACK/rejection starts a fresh interval for remaining ledger work. |
| Held-work signal | Elapsed wall time with ordinary work in `held[]` and no relevant authenticated activity for the live turn | Starts only from an authenticated ready session when the first held owner enters; later held sends do not move it. Relevant turn activity resets it; release/retract/failure of the final owner ends it. |
| Threshold | Public high-level `ackStallTimeoutMs?: number`, default `30_000`; `0` disables both lanes | Accept integers `0..2_147_483_647` only. This is a recovery policy, not a correctness bound, aligned with the existing 30 s retry cap (`nats-client.ts:2179-2183`) and wrapper stale-draft grace (`nats-client-wrapper.ts:184`). |
| Watchdog recovery call | At most one per continuous lane episode through package-internal `requestApplicationRecovery()`; an unrelated raw loss consumes active allowances without another watchdog call | The common method uses raw public `reconnect()` at `nats-client.ts:904-916`; higher layers never call private `forceReconnect()` (`:987`). |
| Episode end | An authenticated ACK or overloaded rejection that matches at least one currently ledgered ID, explicit `disconnect()`, or terminal teardown | An owned application result proves the agent processed this client's ingress. Raw PONG, unknown ACK, and successful registration alone do not prove the stalled send path. |
| Held episode evidence/end | Relevant authenticated typing/progress/reasoning/agent-message activity after ready `onSession` resets the interval and allowance; settlement/release or removal of the last held owner clears it | `onSession` alone is not positive turn activity. Existing settlement and stale-draft logic, not the detector, releases FIFO. |
| Cross-lane arbitration | Every lane uses `requestApplicationRecovery()`; raw false synchronously consumes both active allowances | Whichever lane or genuine raw loss fires first prevents a simultaneous second redial. |
| Receipt policy | No liveness-specific failure | Missing ACK is delivery-unknown, not proof of non-delivery. Keep existing `SendFailure` and `trackerFail()` behavior unchanged. |
| Persistent outage | Existing transient-register retry loop | `registerWithPop` remains bounded per attempt; `onConnected()` already calls public `reconnect()` after transient exhaustion (`nats-client.ts:1672-1685`). Status is `connecting` before the first successful session and `reconnecting` afterward. No v1 cycle ceiling. |
| Idle tabs | Follow-up, not v1 | Both lanes require published or held user work. Preferred long-term solution is an authenticated application probe with an agent instance epoch. |

The 30-second default is an operational recovery policy, not a delivery timeout. It does
not fail a receipt or claim that delivery took less than 30 seconds. A legitimate turn
that is silent longer than the threshold incurs at most one soft reconnect only when user
work is held behind it; the detector still does not fail/release that work. Deployments can
raise the threshold or set it to zero to disable both automatic lanes.

---

## 4. State model and invariants

### 4.1 Per-client no-result age

Add three per-client fields to `WebChannelNatsClient`: the two policy fields
`ackStallSinceAt: number | null` and `ackStallRecoveryIssued: boolean`, plus the monotonic
`ackStallMutationEpoch: number` transaction fence. The first successful raw publish of a
ledgered `user_message` starts `ackStallSinceAt` if it is null.
Later sends, retries, and session replay do not move it while no owned result arrives. A
send that never successfully writes is already handled by transport reconnect and does not
start an application-result clock.

Per-client placement is load-bearing. `flushQueue()` copies ledger messages into
`outboundQueue`, clears the ledger, and reseals them (`nats-client.ts:1863-1876`). Ledger-
only `firstAttemptAt` would be lost by that cycle and could postpone detection forever.
The episode fields survive that clear/reseal and coalesce many unacked IDs into one
continuous no-result interval.

The successful-first-publish transaction is exact. Before sealing, capture the exact
ledger-entry object identity, the sealing `sessionKey` object identity, `connectionEpoch`,
and `ackStallMutationEpoch`, then seal with that key. `sealMessage()` may generate nonce/time,
but it invokes no configured client listener or injected retry seam and is not treated as
an embedder reentrancy point. Next call `retryNow()` exactly once, capture its result as
`attemptAt`, and re-check the exact entry/key/connection/mutation/lifecycle guards. If the
initial retry metadata needs `retryDelay()`/`retryRandom()`, call that seam exactly once and
re-check the same guards again. Only while they still match, commit the guarded
`nextRetryAt` and tracker `lastAttemptAt` to that same entry.

Perform one final full guard immediately before raw `publish()`
(`nats-client.ts:1971-1999`): the exact ledger entry remains owned, the sealing key is still
the current `sessionKey`, the connection and mutation epochs are unchanged, and the client
is non-disconnected/non-terminal. No clock, random, listener, or other injected hook runs
between this final fence and publish. If the guard changed, do not publish ciphertext
sealed for a stale session; the current ledger/queue transaction owns any reseal and later
publish. Raw `publish()` is a synchronous callout: `ws.send()` / `FakeNatsWS.send()` may
synchronously deliver an authenticated ACK or rejection, raw loss, teardown, or a nested
episode before returning.

After `publish()` returns `true`, reuse the captured `attemptAt` and perform a null-to-
`attemptAt` episode start only if all guards still hold: `unackedLedger.get(id)` is the same
captured entry, the session-key identity and connection epoch are unchanged, the client is
non-disconnected/non-terminal, and `ackStallMutationEpoch` still equals the captured value.
If `ackStallSinceAt` is still null, increment the mutation epoch first and assign the
timestamp **before** `trackerAdvance(id, "sent")` or timer scheduling. Do not call
`retryNow()` again. If any guard fails, write no episode state; the owned result, raw loss,
teardown, or nested episode wins. Existing authoritative tracker logic still runs, so a
synchronously accepted or failed send cannot be regressed to `sent`.

The tracker transition invokes public synchronous send-state listeners, and the injected
clock and scheduler are also synchronous callouts; no episode mutation may trail those
callouts.
An ordinary publish while `ackStallSinceAt` is already non-null does not increment it: an
outer owned-result transaction legitimately starts one fresh interval for all work that
remains after its authoritative frame detachment, including that new publish.

### 4.2 Per-client recovery episode

The recovery-issued field is the per-`WebChannelNatsClient` latch:

```ts
private ackStallRecoveryIssued = false;
private ackStallMutationEpoch = 0;
```

`ackStallMutationEpoch` is a monotonic same-client transaction fence. It never resets in
`resetSession()` or `onSession`; it is distinct from connection epochs and the live-timer
generation. Increment it before any injected/public callout whenever code (a) starts an
episode from a null timestamp, (b) consumes the watchdog allowance from false to true,
(c) consumes that allowance on raw loss from false to true, or (d) performs explicit or
terminal ownership retirement, or (e) claims an owned authenticated-result transaction
after authoritative frame detachment. Teardown increments even when both episode fields
are already clear, so it invalidates an outer result transaction.

Timer cancellation has its own reentrancy contract. Change `cancelLiveRetryTimer()`
(`nats-client.ts:2185-2189`) to increment the generation, capture the current timer handle,
and set `liveRetryTimer = null` **before** invoking injected `retryClearTimeout(handle)`.
The clear hook is a synchronous callout and may re-enter disconnect/connect. It must always
observe that the old handle is no longer owned by the client.

Its invariants are:

- A watchdog `false → true` first increments `ackStallMutationEpoch`, then commits the latch
  **before** calling `requestApplicationRecovery()`. The commit is
  complete before a raw state listener, scheduler hook, or other synchronous callout can
  re-enter the client.
- The latch is per client, not per wire ID. One scan may find many expired IDs, but it
  performs one transition and one reconnect call.
- A non-explicit, non-terminal raw `onState(false)` (`!disconnected &&
  !terminalReached`) consumes the current episode's recovery
  allowance whenever `ackStallSinceAt !== null` and `unackedLedger` is nonempty. In
  `WebChannelNatsClient`'s already-registered raw state handler
  (`nats-client.ts:1250-1253`), if the latch is false, increment the mutation epoch and set
  `ackStallRecoveryIssued = true` atomically **before** `resetSession()` or any downstream
  callback. If it is already true, the allowance was already consumed and neither field
  changes. A real socket loss is already a recovery
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
  then increment `ackStallMutationEpoch`, set `ackStallSinceAt = null` and
  `ackStallRecoveryIssued = false`, then call the
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
3. Delete **all** frame IDs from the ledger. If `ownedResult`, immediately claim
   `const resultEpoch = ++ackStallMutationEpoch` **after authoritative detachment and before
   cancellation**. Then call the reordered live-timer cancellation helper.
   `retryClearTimeout` is the first possible callout: it receives a captured handle
   after the instance handle was nulled and may re-enter lifecycle methods. This preserves
   the existing authoritative whole-frame detach rule without falsely claiming cancellation
   itself is callout-free.
4. After cancellation returns, keep every episode write behind both the captured lifecycle
   guards and `ackStallMutationEpoch === resultEpoch`; re-check ledger ownership/size too.
   A nested owned result, null-episode start, watchdog/raw-loss consumption, or teardown
   advances the epoch and wins; the outer result must not overwrite it.
5. If `ownedResult`, the guards/epoch still match, and the ledger is empty, do **not**
   invoke `retryNow()`; clear `ackStallSinceAt` and `ackStallRecoveryIssued` directly. If
   the guarded ledger remains nonempty, invoke injected `retryNow()`, then re-check the full
   lifecycle/session guard, mutation epoch, and nonempty ledger again. Only then write
   `ackStallSinceAt = resultAt` and `ackStallRecoveryIssued = false`. If the clear hook,
   clock, nested result, new episode, or teardown changed the fence, do not overwrite it.
6. Apply authoritative tracker transitions to every detached frame ID even if `retryNow()`
   or an earlier tracker listener changed lifecycle: ACK advances to `accepted`; rejection
   keeps the existing `failed{overloaded}` path. These results belong to the detached
   authenticated frame.
7. Call the trailing `armLiveRetryTimer()`; its existing session/disconnected/terminal and
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

### 4.5 Wrapper-held work episode

Add per-wrapper state:

```ts
private heldStallSinceAt: number | null = null;
private heldStallRecoveryIssued = false;
private heldStallTimer: ReturnType<typeof setTimeout> | null = null;
private heldStallTimerGeneration = 0;
```

When an ordinary non-abort send first becomes owned by `held[]` while
`sessionEstablished` is true and `turnInFlight()` / the FIFO hold latch is active, start
`heldStallSinceAt` from the current clock and arm one timeout for the remaining public
`ackStallTimeoutMs` as read from the inner client's resolved getter. Commit held ownership,
timestamp, latch, and timer generation before any receipt/state listener callout. Further
held sends join the same interval without
moving it and receive no wire ID until `maybeRelease()` normally publishes them.

If a hold begins while raw/session readiness is false, record the episode but set
`heldStallRecoveryIssued = true` and arm no timer: recovery is already in progress. A raw
false while held ownership exists does the same before wrapper state callbacks and cancels
the held timer. Successful `onSession` alone neither clears nor re-arms the allowance.

For each decrypted inbound message, evaluate held activity **before** `handleFrame()`, any
state reducer, or public callback. Snapshot the pre-frame result of `turnInFlight()` and
reset `heldStallSinceAt` to the activity time, set the latch false, and re-arm one timeout
only when all of these are true: `held[]` is nonempty, `sessionEstablished` is true, the
wrapper is non-closed/non-terminal, the pre-frame `turnInFlight()` result is true, and
`msg.type` is exactly `typing`, `progress`, `reasoning`, or `agent_message`. This predicate
does not require a request, turn, or message identifier: those frame types are the
authenticated activity proof for the one conversation-scoped live-turn latch.

History, commands, approvals, snapshots, ACK/rejection frames, `turn_settled`, and raw
PONG never reset this interval. In particular, do not run the activity reset after the
reducer, because a frame may change the turn latch. Settlement and reducer-driven
`maybeRelease()` exclusively own ending the turn and releasing FIFO work. A later frame
that satisfies the full pre-reducer predicate may establish a genuinely new held
episode/allowance even if the older ACK lane remains spent.

At timer expiry, first validate timer generation, held ownership, ready session,
non-closed/non-terminal state, timestamp, and unissued latch. Null the timer handle,
advance its generation, and set `heldStallRecoveryIssued = true` **before** calling
`client.requestApplicationRecovery()`. The detector never fails a held receipt, retracts
it, synthesizes `/stop`, releases FIFO, or reserves/mints a wire ID.

Cancellation is ownership-first and reentrancy-safe: increment the held timer generation,
capture/null its handle, then clear it. Whenever `maybeRelease`, retract, `/stop`, close,
terminal failure, or another detach/fail path removes the last held owner, detach it and
clear `heldStallSinceAt`, the latch, and timer before receipt/state callbacks. A raw false
also clears typing before public state fanout; after replacement readiness, typing-only
holds can release normally. A still-`working` draft is handled by the existing
post-`onSession` stale-draft valve (`nats-client-wrapper.ts:174-184`, `:701-758`), which
eventually finalizes a genuinely stale draft and invokes `maybeRelease()`.

Held timer arming follows a generation transaction: cancel first; capture the post-cancel
generation, held-owner presence, session/closed/terminal state, timestamp, and latch;
compute remaining time; increment/capture the installation generation; call `setTimeout`;
then install the returned handle only if every guard is unchanged. Otherwise clear only
that returned handle. The expiry callback likewise validates its captured generation and
all ownership/lifecycle guards before nulling the handle, advancing generation, committing
the latch, and making the recovery callout. Activity/reset and last-owner cleanup complete
their state mutation and timer retirement before any reducer/receipt listener fanout.

Use Vitest fake timers for this wrapper-owned timer. No second public timeout option or
wire/plugin behavior is introduced.

---

## 5. Detection and scheduling algorithm

Add `ackStallTimeoutMs` to the public high-level `WebChannelNatsClientOptions` at
`packages/client/src/nats-client.ts:276`, **not** raw `NatsClientOptions` at `:64`: raw
`NatsClient` does not consume this application-level policy. The
`WebChannelNatsClient` constructor is the **single timeout authority**: it alone validates
the raw option, defaults it to `30_000`, and stores the result in one private readonly
`resolvedAckStallTimeoutMs` value. Accept only integer values in
`0..2_147_483_647`; reject negative, greater-than-max, non-finite, and non-integer inputs
there. Add package-internal `/** @internal */ getAckStallTimeoutMs()` for that resolved
value; `WebChannelNatsClient` remains absent from the package barrel, so the getter is not
a new public package API. The wrapper passes its raw option through
unchanged when constructing the inner client, then reads the resolved value from that
getter for its held lane. It must not repeat validation, defaulting, or store a separately
resolved copy. Thus ACK and held timers always use the same resolved number, including
the exact disabled value `0`. The upper bound is the portable 32-bit timer maximum. Node
clamps oversized `setTimeout` delays to about 1 ms, which would turn a permissive large
value into a reconnect storm rather than a long timeout.

`armLiveRetryTimer()` is a fenced transaction because injected `retryNow`,
`retrySetTimeout`, and `retryClearTimeout` are synchronous reentrancy points:

1. Call the reordered `cancelLiveRetryTimer()` first. Then capture its post-cancel
   `liveRetryTimerGeneration`, `connectionEpoch`, exact `sessionKey` identity,
   `ackStallMutationEpoch`, disconnected/terminal flags, and the ledger scan inputs
   (ledger size plus each scanned id → entry object identity/`nextRetryAt`, earliest retry,
   episode timestamp/latch, and ownership presence).
2. Call `retryNow()` once. Immediately afterward, compare every captured guard, including
   timer generation and ledger/session ownership. If any changed, return **without**
   cancelling, clearing, installing, or otherwise touching a nested timer. The nested
   result/send/loss owns scheduling.
3. Only an unchanged transaction computes
   `retryRemaining = max(0, earliestNextRetryAt - now)` and
   `stallRemaining = max(0, ackStallTimeoutMs - max(0, now - ackStallSinceAt))`, then uses
   the minimum available value. `0` omits the stall candidate. This avoids unsafe absolute
   deadline addition and keeps every delay within `2_147_483_647`.
4. Capture/increment the installation generation, invoke `retrySetTimeout`, and retain the
   existing post-call guard. If that callout changed generation/lifecycle/session/mutation
   or ledger ownership, clear only the newly returned handle and never overwrite a nested
   handle; otherwise install and `unref` it.

`retryDueUnacked()` applies the analogous fence at entry. Capture timer generation,
connection epoch, exact session key, mutation epoch, lifecycle flags, and relevant ledger
size/id → entry identities and due timestamps; invoke `retryNow`; then re-check all of them
before watchdog or retry mutation.
If a synchronous result, send, or loss changed any guard, return without re-arming or
touching nested scheduling. Only a current transaction may evaluate elapsed time, call
`requestApplicationRecovery()`, seal a retry, update retry metadata, and finally arm again.

Each individual retry in that current transaction has a second, exact fence. Capture the
due entry object, current session-key identity, connection epoch, mutation epoch, timer
generation, and lifecycle state. Set the tracker's `lastAttemptAt` from the captured
`retryNow()` value **before** raw publish, then publish the resealed retry. A `false` publish
returns immediately because raw transport recovery owns the result. After a `true`
publish, re-check every captured guard and entry identity; if anything changed, return
without writing stale retry metadata and without cancelling, replacing, or arming a nested
timer. Only an unchanged retry may call `retryRandom()`/`retryDelay()`; immediately re-check
all guards once more after that injected callout, then update `nextRetryAt`/attempt metadata
on that same entry. Synchronous owned ACK/rejection, a nested send from a tracker listener,
raw loss, and `retryRandom()` reentry therefore always win over the outer retry transaction.

Computing `min(retryRemaining, stallRemaining)` is essential because retry backoff reaches
30 seconds and must not overshoot a shorter policy threshold. Add no independent low-level
liveness timer. `ackStallMutationEpoch` is a synchronous mutation fence distinct from the
existing timer generation.

---

## 6. Recovery and replay path

Add `/** @internal */ WebChannelNatsClient.requestApplicationRecovery(): boolean`, exposed
only for the sibling wrapper within the package. Both the
ACK watchdog and wrapper-held timer use it. It returns false without mutation when the
mid-level client is explicitly disconnected or terminal. ACK-episode ownership is **not**
an eligibility requirement: if an active, unissued ACK episode exists, atomically consume
it (advance mutation epoch, set the ACK latch); if no ACK episode exists or its allowance
is already spent, still retire the live retry timer and proceed with wrapper-only recovery.
Capture the current connection epoch before callback-visible work.
Because injected timer-clear is reentrant, re-check epoch/disconnected/terminal state after
retirement; if it changed, return false because nested loss/teardown already owns recovery.
Otherwise call only raw public `this.client.reconnect()`
(`packages/client/src/nats-client.ts:913-916`) and return true. It must never reach through
to private `forceReconnect()`.

The held lane commits its own latch before this call. Public raw reconnect synchronously
fans out raw false: the mid-level raw handler consumes any still-active ACK allowance and
invalidates the session; the wrapper raw handler consumes any still-active held allowance
before public state callbacks. Thus ACK watchdog, held watchdog, and genuine raw loss
coalesce into one redial. A later authenticated turn-activity reset may legitimately allow
one later held recovery even when the older ACK episode remains consumed.

The existing path then supplies all recovery mechanics:

1. Raw soft reconnect tears down and redials.
2. Raw `onState(true)` invokes `onConnected()` (`nats-client.ts:1250-1253`).
3. `onConnected()` replaces the `.out` subscription before registration
   (`:1604-1612`).
4. Existing PoP registration re-establishes plugin peer state and installs an authenticated
   conversation key (`:1625-1793`).
5. `flushQueue()` moves the unacked messages to the front and reseals them with the same
   wire IDs (`:1863-1876`). The production outcome/lease path looks up the durable chosen
   outcome before dispatcher admission (`packages/plugin/src/ingress-dedupe.ts:246-251`,
   `:289-318`, `:405-430`): a previously accepted ID is ACKed without a new lease offer or
   dispatch. The focused restart-composition test required by §9.2 is the authority for
   this guarantee.

No plugin file, NATS subject, envelope, ACK shape, `SendFailure.reason`, or receipt state is
changed.

### 6.1 Stale-session notification fence

On every raw `onState(false)`, increment/invalidate `connectionEpoch` **before**
`resetSession()` and before any downstream callback. This includes a synchronous raw
publish failure during ledger replay.

In `onConnected()`, retain the captured epoch and raw `connectionGeneration`. After key
installation, `drainPendingInbound()`, and `flushQueue()`, require all of these to remain
current before `notifySessionListeners()`:

- captured `connectionEpoch` equals the instance epoch;
- captured raw connection generation equals `client.currentConnectionGeneration()`;
- `sessionKey` is the exact installed key object;
- the client is non-disconnected and non-terminal.

Re-check after each synchronous callout boundary and once immediately before notification.
If replay's `ws.send()` throws and raw `publish()` drives `forceReconnect`, raw false
invalidates the epoch/key, so the stale flow cannot emit `onSession`. Consequently the
wrapper cannot flash public `connected`, arm a stale-draft watch for a dead session, or
release held FIFO work. A later genuine registered/keyed session may notify normally.

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

- On raw false, commit `sessionEstablished = false`; if `held[]` is nonempty, consume its
  allowance and cancel its timer; clear typing and connection-scoped watches; then commit
  the public non-ready state. All held-lane mutation precedes listener notification.
- On session success, first guard terminal/closed state, then commit
  `sessionEstablished = true` and `everSessionEstablished = true`, then set public
  `connected`. Because `setState` is an embedder callout, re-check terminal/closed and the
  session flag before arming the stale-draft watch or releasing held work. A listener that
  synchronously closes the client must not be followed by stale `maybeRelease()` work.
  `onSession` alone does not clear either recovery latch.
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
| Production | `packages/client/src/nats-client.ts` | Add `ackStallTimeoutMs` on `WebChannelNatsClientOptions`; make this constructor the sole validator/defaulter and store one private readonly resolved value with a package-internal getter; add package-internal `requestApplicationRecovery`; reorder cancellation; add ACK episode/mutation state; fully fence arm/tick scheduler callouts; consume raw-loss allowance and invalidate `connectionEpoch`; prevent stale `onSession`; correct credential comment. |
| Production | `packages/client/src/nats-client-wrapper.ts` | Forward the raw timeout option unchanged, then read the inner client's resolved value through its package-internal getter without duplicate validation/defaulting; add held episode/timer/generation and cleanup across every ownership path; use `requestApplicationRecovery`; separate raw transport from session readiness and guard reentrant `onSession`. `WebChannelNATSClientOptions` inherits the field through `DirectClientOptions`. |
| Unit test (new) | `packages/client/src/nats-client-agent-liveness.test.ts` | ACK detector/validation, episode/replay races, scheduler reentrancy, raw-loss arbitration, and mid-level stale-`onSession` tests using `FakeNatsWS`. Existing `nats-client-liveness.test.ts` remains raw heartbeat/auth and is untouched. |
| Unit regression | `packages/client/src/nats-client-sendstate.test.ts` | Extend its local setup option seam and construct the existing exact 1/2/4/8/16/30-second backoff test with `ackStallTimeoutMs: 0`, so it remains the legacy retry-schedule authority rather than inheriting the new default stall wake-up. |
| Unit test (new) | `packages/client/src/nats-client-wrapper-agent-liveness.test.ts` | Public option forwarding, W1-W5 readiness/stale-session assertions, and deterministic H1-H6 held-work recovery/cleanup/arbitration tests. |
| Component test | `packages/plugin/src/nats-channel-s2.test.ts`, `packages/plugin/src/ingress-dedupe.test.ts` | Compose eviction/re-register and add a focused production `outcomeStore` + `beginBatch` durable-restart replay test. The legacy `checkAndRecord` tests remain regression evidence only; no plugin production change. |
| Public docs | `packages/client/README.md` | Document the shared ACK/held semantics, default/range/0-disables-both behavior, delivery-unknown/no-auto-release policy and long-silent-turn tradeoff, plus authenticated-session meaning of `connected`. |
| Release notes | `packages/client/CHANGELOG.md` | Under Unreleased, record the Added public option and Fixed published-send, held-work, stale-session-readiness gateway recovery; classify wire-compatible/non-breaking with no protocol bump. |

Explicitly unchanged: `packages/client/src/types.ts` send-failure unions,
`packages/plugin/**` production code, SaaS credentials, NATS parser, wire protocol, demo UI,
and package/version manifests in the implementation PR.
Plugin tests may be extended only to compose existing eviction/re-register/dedupe contracts;
they must not require a production plugin change. Manifest bumps are deferred to release
cutting per `docs/PUBLISHING.md`, not forgotten.

### 8.1 Compatibility and release classification

This is an additive exported option plus a visible readiness bug fix. For the pre-1.0
client, classify it as the next semver-minor release. `v0.4.0` is already tagged, so the
current target is the next unpublished three-way lockstep minor, presently `0.5.0` (or the
next minor if the branch advances before release).

The implementation PR does not edit `package.json`, `package-lock.json`, or version
manifests; they remain unchanged in implementation scope. When the release is cut,
client/SaaS/plugin versions move together under the
repository's three-way lockstep rule even though #81 production code is client-only. The
wire remains compatible and `WEBCHANNEL_PROTOCOL_VERSION` does not change.

Implementation order:

1. Add failing client tests for a healthy raw relay with no application ACK and for exact
   stall-deadline scheduling, including synchronous ACK/rejection during raw publish.
2. Add the option to high-level `WebChannelNatsClientOptions`; validate/default it only in
   the inner constructor into its private readonly resolved value and add the
   package-internal getter. Verify the public type surface; have the wrapper forward the
   raw option unchanged and read the resolved getter only after constructing the inner
   client, then add both lanes' fields.
3. Reorder `cancelLiveRetryTimer()` so ownership is nulled before its injected clear hook.
   Implement fully fenced `armLiveRetryTimer()` / `retryDueUnacked()`, guarded publish and
   result transactions, and `requestApplicationRecovery()`.
4. On raw false consume ACK allowance and increment `connectionEpoch` before reset/callbacks;
   add the post-drain/flush session-key/generation fence before `notifySessionListeners()`.
5. Make wrapper readiness session-aware; implement held episode start/activity/reset,
   timer expiry, cross-lane raw-loss arbitration, and ownership-first cleanup for
   `maybeRelease`, retract, `/stop`, close, terminal, and reentrant paths.
6. Isolate the existing exact-backoff sendstate regression with `ackStallTimeoutMs: 0` and
   add the production outcome/lease persistent-restart dedupe composition test.
7. Correct the credential-scope comment; update `packages/client/README.md` and the
   Unreleased section of `packages/client/CHANGELOG.md` with the public contract and
   compatibility classification above.
8. Run focused client tests, mandatory plugin component tests, the client suite, and
   structural checks. Qualify the pushed implementation SHA through external Rota S7 as
   specified in §9.3; leave package/version manifests for release cutting.

---

## 9. Verification matrix

### 9.1 Client `FakeNatsWS` tests

`FakeNatsWS` can prove a generic healthy-relay/no-ACK condition and wrapper readiness. It
cannot prove real plugin peer-cap eviction or plugin ingress dedupe.

| ID | Scenario | Required assertion |
|---|---|---|
| C1 | Session established; send publishes; no ACK; raw PONG remains healthy | No reconnect before 30 s; one public recovery reconnect at exactly 30 s even when next retry is later. |
| C2 | `ackStallTimeoutMs: 0` | Existing retry/reconnect behavior continues and neither automatic recovery lane fires; the isolated sendstate regression retains exact delays `[1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]`; wrapper readiness is still session-aware. The new agent-liveness suite separately owns default `min(stallRemaining, retryRemaining)` scheduling. |
| C2a | Single option authority and validation | The inner constructor alone resolves default 30,000 and accepts `0` and `2_147_483_647`; `-1`, `2_147_483_648`, `NaN`, infinities, and fractional values throw there. The wrapper forwards the raw field unchanged, performs no duplicate validation/default, reads the inner package-internal getter only after construction, and both lanes observe the identical resolved value including `0`. Raw `NatsClientOptions` does not advertise it and the inner class/getter is not barrel-exported. |
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
| C13 | A and B are ledgered; ACK A reaches `_retryNow`, which synchronously delivers an encrypted owned ACK/rejection for B through `FakeNatsWS` | Nested result detaches B and advances `ackStallMutationEpoch`; the outer A transaction fails its fence and writes no stale timestamp. A later send C starts its own interval from its captured attempt and does not reconnect immediately. |
| C14 | `FakeNatsWS.send()` synchronously emits an encrypted owned ACK, then separately an overloaded rejection, for the just-published ID | Captured ledger/session/connection/mutation guards reject the stale post-`publish(true)` episode start; authoritative accepted/failed state wins. A later send starts from its own captured attempt and does not reconnect immediately. |
| C15 | `_retryNow` inside outer `armLiveRetryTimer()` synchronously delivers an owned result; its tracker callback sends fresh B | Nested result/send owns B's one-second timer. The outer arm observes changed timer/lifecycle/mutation guards, does not clear or replace B's handle, and leaks no orphan. Add result and disconnect variants at arm/tick entry. |
| C16 | Reconnect replay throws synchronously from `ws.send()` during `flushQueue()` | Raw false increments `connectionEpoch`; stale `onSession` never fires. A later real session can register and notify normally. |
| C17 | Initial seal/publish and due-retry callouts synchronously re-enter through `retryNow`, `retryRandom`/`retryDelay`, raw publish, owned ACK/rejection, raw loss, or tracker-triggered nested send | Initial publish calls its clock once, its needed randomization once, re-checks after each seam, commits guarded retry metadata, and never sends ciphertext unless the exact sealing-key, connection, entry, and mutation guards still match at the final immediately-pre-publish fence; no hook intervenes between fence and publish. For a retry, `lastAttemptAt` is set before publish; `publish(false)` exits, and every post-`publish(true)` or post-randomization metadata write targets the same entry only after all guards still match. An owned result or nested send wins, with no stale retry metadata and no outer touch of its timer. |
| W1 | Initial raw socket opens before registration resolves | Wrapper remains `connecting`, `connected: false`. |
| W2 | Established session loses raw transport; replacement raw socket opens | Wrapper remains `reconnecting`, `connected: false` until replacement `onSession`. |
| W3 | Replacement registration gets transient 503/exhaustion | Raw reconnect loops while wrapper never flashes connected. |
| W4 | State listener closes synchronously during session-ready notification | No stale watch/release work and no ready-state revival. |
| W5 | C16 through the public wrapper with held FIFO work | No false public `connected`, stale-draft arm, or held release from the abandoned session; later genuine `onSession` may recover. |

Held-work wrapper tests use Vitest fake timers and the production wrapper:

| ID | Scenario | Required assertion |
|---|---|---|
| H1 | A is accepted and emits typing/progress/working; gateway application disappears while raw relay stays healthy; ordinary B enters `held[]` | B remains `queued` with no `wireId`; no redial before the shared threshold and exactly one at expiry. Replacement registration stays non-ready until `onSession`; the existing stale-draft valve finalizes a genuinely stale A, releases FIFO B, and B completes without detector-driven failure/retraction. |
| H2 | Decrypted inbound frames arrive while B is held | Before reducer/callback execution, snapshot `turnInFlight()`. Reset the interval/allowance only when held ownership exists, the session is established, the wrapper is nonclosed/nonterminal, that pre-frame value is true, and the type is exactly typing/progress/reasoning/agent-message; no ID is required. History, commands, approvals/snapshots, ACK/rejection, `turn_settled`, and raw PONG do not reset. Settlement/reducer/`maybeRelease()` owns release. |
| H3 | Held expiry, ACK watchdog expiry, and genuine raw loss interleave | The first path commits before callout; synchronous raw-false fanout consumes both active allowances; exactly one socket replacement occurs and later authenticated turn activity can create one genuinely new held allowance. |
| H4 | `ackStallTimeoutMs: 0` with published and held work | Neither automatic lane requests recovery; readiness correction, ordinary retries, and manual/raw reconnect behavior remain. |
| H5 | Last held owner is released/retracted by `maybeRelease`, `/stop`, explicit retract, close, or terminal failure, including listener reentry | Ownership and held episode/timer are cleared before callbacks; no wire ID is minted for removed held work and no stale timer fires. |
| H6 | Hold begins while session readiness is false, including typing-only state cleared by raw false | Allowance is recorded consumed with no parallel timer. `onSession` alone does not re-arm; normal ready release or stale-draft processing clears the final owner safely. |

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
- add a focused test to `packages/plugin/src/ingress-dedupe.test.ts` through the production
  `createIngressOnFlush({ outcomeStore, beginBatch, ... })` branch. In one isolated
  `OPENCLAW_STATE_DIR`, construct the real accepted and overloaded
  `createPersistentDedupe` adapters with their production namespace prefixes, wrap them in
  `createIngressOutcomeStore` (matching `ingress-outcome.ts:546-553`), and seed/commit a
  durable `accepted` outcome for one account + `peer:id`;
- discard those adapter/store instances, recreate both real persistent adapters and the
  outcome store from the **same** isolated state directory to model a gateway process
  restart, then replay that peer/id through a fresh production `createIngressOnFlush` with
  a `beginBatch` lease spy;
- assert the replay publishes ACK for the ID, but makes no lease `offer`, logical dispatch,
  or `inbound_rejected` publication. This focused outcome/lease restart test is the
  production authority for same-ID recovery. The legacy `checkAndRecord` tests at
  `ingress-dedupe.test.ts:570-668` may remain regression evidence but are not cited as the
  production contract;
- the S2 cap test and focused persistent outcome test are composition evidence, not an
  end-to-end claim or a change to plugin production code.

### 9.3 Regression and external product gate

Run at minimum:

```sh
npm test --workspace packages/client -- nats-client-liveness.test.ts
npm test --workspace packages/client -- nats-client-agent-liveness.test.ts
npm test --workspace packages/client -- nats-client-sendstate.test.ts
npm test --workspace packages/client -- nats-client-wrapper-agent-liveness.test.ts
npm test --workspace packages/client -- nats-client-wrapper.test.ts
npm test --workspace packages/plugin -- nats-channel-s2.test.ts ingress-dedupe.test.ts
npm test --workspace packages/client
npm run typecheck
```

The first command above keeps the existing raw heartbeat/auth liveness suite unchanged; the
new application-liveness work belongs in the distinct agent-liveness file. Unit and plugin
component tests are mandatory even when local live-harness prerequisites are unavailable.

The authoritative live acceptance gate already exists outside this repository. No new
`e2e/local` harness is needed, per the maintainer's issue comment.

- Repository: `mir-stream/rota-crew`
- Branch: `test/wc-v040-product-e2e`
- Observed head on 2026-08-07: `f05022f3ffb4a57f8d7c6df5ba9226e9cfddb936`
- Command: `npm run test:webchannel:product-e2e`
- Artifact:
  `.artifacts/webchannel-product-e2e/<run-id>/browser/restart-result.json`

Rota scenario S7 already holds one browser alive, restarts NATS, then restarts the gateway
alone. Retain its current post-restart send case and required green checks
`S7.gateway-restart-recovered` plus `S7.gateway-restart-turn-completed`, with no
gateway-related `known-red` checks.

In the Rota qualification test commit, add a **second, independently orchestrated
gateway-only restart** after that existing case. Its executable choreography is:

1. Configure S7's bounded slow stream so turn A emits accepted and then a visible
   progress/working state, but cannot settle before the host kills the gateway. Record
   green checks `S7.gateway-restart-held-first-accepted` and
   `S7.gateway-restart-held-first-working`.
2. While A is visibly working and **before** any gateway restart, the browser sends ordinary
   follow-up B. Prove B is held locally rather than dispatched by requiring its UI receipt
   to expose `data-send-state="queued"`, requiring the pending-only Cancel affordance, and
   requiring the harness's echo/dispatch metric for B to remain exactly zero. This records
   `S7.gateway-restart-held-followup-local`. Rota does not inspect or require a wire ID;
   H1 alone owns the no-wire-ID-before-release contract.
3. Only after those three observations, the browser writes an explicit ready marker for
   the host. The host must wait for that marker, kill and restart the gateway alone while
   keeping the browser and NATS relay alive, and then signal the browser that the gateway
   restart has completed. Killing earlier makes the case invalid rather than green.
4. The browser waits for eventual authenticated online/session-ready state after the
   replacement registration and key establishment, then records
   `S7.gateway-restart-held-session-ready`. Scenario code must record/evaluate this check
   before evaluating the final completion assertion and must establish eventual
   authenticated online by the time recovery completes. It must not require a rendered
   intermediate frame in which online/session-ready is visible while B is still held:
   React may batch `onSession` readiness and immediate `maybeRelease()` updates. W1-W5 and
   H1-H6 own exact ordering and status traces.
5. Then require held-lane recovery/stale-draft FIFO release and B's reply completion,
   recording `S7.gateway-restart-held-recovered` and
   `S7.gateway-restart-held-turn-completed`.

The original gateway-only phase and this held-work phase each receive their own bounded
120-second recovery window; neither may borrow unused time from the other. Increase the
overall host and browser deadlines to cover setup plus both full windows and teardown.
`browser/restart-result.json` keeps its current schema exactly
`{status, phase, failedCheck, checks}`; the six check IDs above are explicit required-green
entries in `checks`. Do not expand the artifact schema merely to carry raw observations—
the existing phase/check evidence and harness diagnostics are sufficient unless Rota's
implementation later demonstrates a concrete need.

Exact status traces remain owned by W1-W5/H1-H6; C4 plus plugin ingress-dedupe tests own
same-ID republish and one-logical-dispatch proof. S7 is the product recovery gate, not a
duplicate unit-contract oracle.

Qualification requires a pushed implementation commit. In a Rota test commit, update
`WC_REF` and `expected-manifest.json.webchannel.checkoutSha` to that exact implementation
SHA; Rota's `prepare-source` enforces the canonical sibling checkout. This coordination is
external test work, not a file change in `openclaw-webchannel`, and the current plan-only
SHA cannot qualify. Run from the Rota branch:

```sh
npm run test:webchannel:product-e2e
```

The external gate may be unavailable from this worktree, but it is mandatory before release
or issue closure. Focused unit and plugin component gates remain mandatory implementation-
PR checks regardless of Rota availability.

---

## 10. Alternatives and follow-ups

| Alternative | Coverage | Cost / limitation | Disposition |
|---|---|---|---|
| Published/held stall → common soft reconnect (this plan) | Reactive restart recovery for sent work and follow-ups blocked behind a live-turn latch | One redial and redundant register snapshots; a legitimately silent long turn with held user work can cause one false-positive reconnect; no idle detection | **Chosen v1:** client-only, preserves receipt/FIFO semantics, reuses registration, same-ID replay, and stale-draft release. Raise threshold or use `0` when that tradeoff is undesirable. |
| Auto-release held work or bypass the turn/FIFO gate | Makes the follow-up publish immediately | Changes turn ordering, coalescing, abort, and receipt semantics; can create concurrent turns | Rejected. Recovery may restore the session but only existing settlement/stale-draft logic releases held work. |
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
- No detector-driven held receipt failure/retraction, synthetic `/stop`, FIFO bypass,
  auto-release, or pre-release wire-ID minting.
- No private `forceReconnect()` call from `WebChannelNatsClient`.
- No plugin production change, new subject, header parser work, credential broadening, or
  protocol version bump.
- No claim that one active peer's recovery stabilizes all peers at a saturated cap.
- No claim that a raw PONG proves application readiness.
- No real-time sleeps in deterministic unit tests.

Related work: #48 (wire parser / `no_responders` prerequisite), #57 (busy-turn behavior),
#72/#84 (credential containment), and #51 (registration-state lifecycle family).
