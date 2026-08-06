# Issue #81 — Agent-side session liveness & recovery — Implementation Plan (v1, DRAFT)

> Status: **PLAN DRAFT — not reviewed, not implemented.** Open decisions in §11 must be
> settled before implementation starts.
> Issue: `#81 Gateway restart silently and permanently mutes every live browser session` (priority/P1, kind/bug, area/plugin, area/client)
> Branch: `mir-stream/issue-81`
> Worktree: `/Users/mircorn/orca/workspaces/openclaw-webchannel/issue-81`
> Base: `develop` @ `0dc0636`
> Plan author: advisor session 2026-08-06. Every `file:line` below was read at that commit.

---

## 0. Read this first (orientation for a fresh agent)

**What breaks.** Restarting the OpenClaw gateway process permanently and silently mutes
every browser that was live at the time. The browser still shows "connected", accepts
input, renders the user's own bubble — and nothing ever arrives. There is no error, no
state change, no log line on the agent side. Only a page reload (or an embedder-driven
re-bootstrap) recovers it.

**Why it is P1.** This is not an incident-only path. It happens on every ordinary deploy,
config change, and crash-restart, and the blast radius is the whole process — peers of
accounts entirely unrelated to the restart are muted identically.

**The shape of the fix.** Small, and almost entirely in `packages/client`. The detection
signal and the recovery path both already exist and are already tested; what is missing is
a timer that connects them and an escalation ceiling that ends the silence. See §4.

**What this plan is NOT.** It is not a durable-registration design, not a protocol change,
and not a credential-permission change. §3 explains why each of those alternatives is
either blocked or disproportionate.

---

## 1. Verified mechanics of the defect

### 1.1 Agent-side peer state is in-memory and register-time-only

| Fact | Evidence |
|---|---|
| Per-peer inbound subscription map | `packages/plugin/src/nats-channel.ts:137` (`peerSubscriptions`) |
| Per-peer conversation key map | `packages/plugin/src/nats-channel.ts:202` (`peerSessionKeys`) |
| Both populated **only** in `registerPeer()` | `nats-channel.ts:310-313` |
| `registerPeer()` early-returns when already registered | `nats-channel.ts:287-291` |

A restarted process starts with both maps empty.

### 1.2 Consequences, both directions

- **browser → agent**: the client publishes to `webchannel.{tenant}.{acct}.{peerId}.in`.
  After a restart the agent holds **no subscription** on that subject. Core NATS has no
  retention and silently discards messages with no subscriber. **The agent logs nothing at
  all** — there is no drop warning, because nothing is delivered to drop.
  (The `Dropping inbound … no registered session key` warn at `nats-channel.ts:872-877`
  only fires when a subscription *does* exist but the key is missing — a different case.)
- **agent → browser**: `sendToPeer` fails closed with no session key —
  `nats-channel.ts:697-704` (warn at `:702`), `Refusing to send to <peer>: no session key yet (fail-closed,
  no plaintext)`. One `console.warn`, no state propagation.

### 1.3 Why the client never notices

Three independent reasons, all verified:

1. **The heartbeat probes the wrong endpoint.** `startHeartbeat()` sends a raw NATS
   protocol `PING\r\n` — `packages/client/src/nats-client.ts:952-970`. That frame
   terminates at the **relay**, which is healthy and answers `PONG`. `pongPending` clears
   (`:758`) and `forceReconnect()` never fires. The WebSocket stays open across the entire
   restart.
2. **Registration has exactly one trigger.** `registerWithPop` has a single call site,
   `nats-client.ts:1632`, inside `onConnected()` (`:1580`), reachable only from the
   connection-state listener at `:1251`. No socket drop → no `onConnected` → no
   re-registration. The agent's register subscription **is** a wildcard
   (`webchannel.{tenant}.{acct}.*.register`) and would accept a re-registration; the
   browser simply never sends one.
3. **The unacked retry loop never escalates.** This is the key finding. The client already
   re-publishes unacked `user_message`s forever with exponential backoff:
   - ledger: `nats-client.ts:1190-1194` (`unackedLedger`, entries carry
     `retryCount` / `nextRetryAt`)
   - retry loop: `retryDueUnacked()` `nats-client.ts:2224-2242`, armed by
     `armLiveRetryTimer()` `:2192-2222`
   - backoff: `retryDelay()` `:2179-2183` — `min(30s, 1s · 2^retryCount)` with ±10% jitter
   - **there is no maximum retry count and no escalation.** `retryCount` only saturates the
     delay. The browser republishes into a dead subject every ~30 s, forever, silently.

### 1.4 The user-visible result

`sendState` (P0-4 contract, `packages/client/src/types.ts:29`) advances
`queued → sent` and stops. It never reaches `accepted` (that transition is driven by the
agent's `ack` frame → `drainAcked`, `nats-client.ts:1536`/`:1548`) and never reaches
`failed`. The bubble sits in `sent` indefinitely. `ConnectionStatus`
(`types.ts:279`) stays `"connected"`.

---

## 2. The same defect has a second trigger — peer-cap eviction

This materially raises the value of the fix and **rules out any agent-restart-specific
remedy**.

`nats-channel.ts:293-308` evicts the oldest peer when `maxPeers` is reached. The code
comment already documents this exact failure mode:

> *"NOTE: if the evicted peer is in fact still live, this DROPS its session until it
> reconnects (the browser only re-registers in onConnected, and the client heartbeat keeps
> a healthy socket from reconnecting) — an acceptable last-resort under abuse-level churn,
> not self-healing."*

So the silent-mute state is reachable **with no restart at all**, on a fully healthy
agent, by ordinary peer churn against the cap. A client-side detector closes both doors
with one mechanism. An agent-startup beacon closes only one.

---

## 3. Design constraints — why the obvious alternatives are out

### 3.1 HARD BLOCKER: browser NATS credentials are pinned to the peer subtree

`packages/saas/src/nats-user-creds.ts:171-172`:

```js
pub = [`webchannel.${opts.tenant}.*.${opts.peerId}.>`];
sub = [`webchannel.${opts.tenant}.*.${opts.peerId}.>`];
```

A browser **cannot subscribe outside its own peer subtree.** Therefore:

- ❌ **Agent → broadcast "I restarted" announcement** on a shared subject is impossible
  without re-minting the pub/sub grants in every already-issued browser credential. Those
  credentials are **non-expiring when no TTL is supplied** (see #72), so this drags in the
  whole #72/#84 credential-ledger + revocation program as a prerequisite. Out.
- ✅ Any probe or recovery round trip must live inside
  `webchannel.{tenant}.{acct}.{peerId}.*`. The existing `.in`, `.out`, `.register`, and
  `.reginbox` subjects all satisfy this.

> ⚠️ **Stale comment trap.** `nats-client.ts:1628-1630` claims *"the browser's tenant-wide
> creds already cover pub+sub on `webchannel.{tenant}.>`"*. That is **wrong** for the
> `browser` credential kind — `nats-user-creds.ts:171-172` is the authority (it mints the
> JWT). The register reply prefix happens to be inside the peer subtree
> (`…{peerId}.reginbox`, `nats-client.ts:1631`) so the code works, but do not reason from
> that comment. Consider correcting it as a drive-by in this PR.

### 3.2 Rejected: agent-side startup beacon

Blocked by §3.1, and even if unblocked it (a) only covers restart, not §2 eviction,
(b) depends on the agent reaching a peer it cannot address, and (c) is suppressible and
forgeable by the untrusted relay this project's threat model assumes.

### 3.3 Rejected for v1: NATS `no_responders`

Elegant — a core NATS request to `.in` would return "no responders" instantly and
definitively, with zero agent-side change. But it requires `HPUB`/`HMSG` header support in
the hand-rolled wire client, and that parser is the subject of open issue **#48** (O(n²)
CPU amplification, hostile-relay DoS). Two concurrent rewrites of the same parser is a bad
trade. Revisit after #48 lands.

### 3.4 Deferred: dedicated application-level ping subject

`webchannel.{tenant}.{acct}.{peerId}.ping` with an agent-side **wildcard** `*.ping`
subscription (established at startup, so it survives restarts) would work within §3.1 and
would additionally cover the **idle tab** case (§9.1). It costs a new subject, a new
plugin subscription, a wire-contract addition, and lockstep client/plugin deploy. Out of
v1 scope; recorded as the natural v2 if §9.1 proves to matter.

---

## 4. Chosen design — detect → reconnect → escalate

Three stages. All three reuse machinery that already exists and is already covered by
tests.

```text
   user_message published, no ack
              │
      (existing) retryDueUnacked() republishes with backoff
              │
   ① DETECT   ├─ trip condition on the unacked ledger  ......... NEW
              ▼
   ② RECOVER  forceReconnect()  ............................... EXISTING (private)
              │   → socket redial → onConnected()
              │   → resubscribe .out → resetSession() → registerWithPop()
              │   → agent repopulates peerSubscriptions/peerSessionKeys
              │   → onSession → flushQueue() replays the unacked ledger
              ▼
   ③ ESCALATE after N failed recovery cycles:  ................. NEW
              trackerFail(id, …) + connection status/error surface
```

### 4.1 Stage ① — detection

Trip when a `user_message` has been unacked past a threshold. Two candidate signals, both
already on the ledger entry (`nats-client.ts:1190-1194`):

- `retryCount >= N` — simple, already incremented at `:2235`.
- elapsed since first publish `>= T` — needs a new `firstAttemptAt` field, but is
  independent of backoff-schedule changes and easier to reason about.

**Recommendation: elapsed-time (`T`), with `retryCount` kept as a secondary guard.** See
decision **D1** in §11.

The detector must be evaluated inside the existing retry tick (`retryDueUnacked()`,
`:2224`) rather than on a new independent timer — one timer, one code path, no new
lifecycle to leak.

### 4.2 Stage ② — recovery via `forceReconnect()`

**Do not build a mid-session re-register path.** Call the existing private
`forceReconnect()` (`nats-client.ts:987`). Verified consequences:

| Step | Evidence | Note |
|---|---|---|
| socket torn down, redial scheduled | `:987-1013` | already used by the heartbeat |
| `onConnected()` runs | `:1580` | the single existing registration path |
| `.out` resubscribed **before** register | `:1608-1609` | ordering is load-bearing (no NATS retention) |
| `resetSession()` — **keeps the unacked ledger** | `:1497-1509` | explicit in the comment at `:1507` |
| `registerWithPop()` over NATS request/reply, 5 s timeout | `:1632-1645` | bounded retry + terminal classification lives in `pop-register.ts` |
| agent re-registers idempotently, re-wraps K, resends snapshots | `packages/plugin/src/nats-register.ts:467-521` | `registerPeer` early-returns if present, but wrap + reply + snapshots run regardless |
| `flushQueue()` prepends the ledger to the outbound queue and replays with the **same ids** | `nats-client.ts:1863-1876` | agent-side ingress dedupe makes replay exactly-once |

Net effect: the user's stuck message is delivered, the bubble advances to `accepted`, and
the user never learns anything went wrong. That is the correct outcome.

**Why this is safe when the agent is actually healthy (false positive):** the re-register
is idempotent (`nats-channel.ts:287-291` + `nats-register.ts:467-521`). The cost is one
socket redial, a two-phase PoP round trip, and a **redundant history + approval snapshot**
resend to the browser. Not free — which is why the threshold in D1 must sit well above
worst-case ingress-ack latency.

### 4.3 Stage ③ — escalation

If recovery cycles keep failing (agent genuinely down), stop being silent:

- fail the receipt: `trackerFail(id, failure)` (`nats-client.ts:2041-2047`) →
  `onSendState(id, "failed", failure)`.
- surface the connection state so the widget can render something truthful.

The `SendFailure.reason` union (`types.ts:54-62`) has **no existing member that fits**:
`closed`/`evicted`/`terminal`/`overloaded`/`turn-failed`/`cancelled` all mean something
else. Adding a member (e.g. `"unreachable"`, `retryable: true`) is a public-type change on
an exported union. See decision **D2** in §11.

`ConnectionStatus` (`types.ts:279`) is `"connecting" | "connected" | "reconnecting" |
"error"`. The natural intermediate is `"reconnecting"` during stage ②. `"error"` is
documented as **terminal**, and terminal recovery requires a fresh client instance — so do
not reach for it unless the situation really is unrecoverable. See **D3**.

---

## 5. Machinery inventory — what already exists

Written out so the implementer does not rebuild any of it.

| Need | Already exists | Location |
|---|---|---|
| Per-message delivery signal | `ack` frame → `drainAcked()` | plugin `nats-channel.ts:499`; client `:1536`, `:1548` |
| Unacked bookkeeping | `unackedLedger` + `retryCount`/`nextRetryAt` | client `:1190-1194` |
| Backoff retry loop + generation-safe timer | `retryDueUnacked`, `armLiveRetryTimer`, `cancelLiveRetryTimer` | client `:2179-2242` |
| Socket teardown + redial | `forceReconnect()` | client `:987` |
| Full re-registration | `onConnected()` → `registerWithPop` | client `:1580`, `:1632` |
| Ledger replay on session (re)establishment | `flushQueue()` | client `:1863-1876` |
| Terminal receipt failure + listener plumbing | `trackerFail`, `emitSendState`, `onSendState` | client `:2041`, `:1444` |
| Injectable clock/scheduler/RNG for deterministic tests | `retryNow`, `retryRandom`, `retrySetTimeout`, `retryClearTimeout` | client `:1201-1204` |
| Fake nats-server + agent harness | `FakeNatsWS`, `makeClient`, `registerAgent`, `settle` | `packages/client/src/nats-client-wrapped.test-harness.ts` |
| Precedent test for "register fails → recover → send works" | `nats-client-register-recovery.test.ts` | whole file |

**The injectable scheduler quartet at `:1201-1204` is the single most important thing to
know for testing.** Every timing assertion in this work can be made deterministic through
it; do not introduce real timers.

---

## 6. Files expected to change

| File | Change | Size |
|---|---|---|
| `packages/client/src/nats-client.ts` | trip detection in `retryDueUnacked`, escalation counter, `forceReconnect` call, `trackerFail` on ceiling | core of the work |
| `packages/client/src/types.ts` | new `SendFailure.reason` member (pending **D2**) | small, public API |
| `packages/client/src/nats-client-wrapper.ts` | map the new failure/status into `WebChannelState` | small |
| `packages/client/src/nats-client-liveness.test.ts` | extend, or add a sibling `…-agent-liveness.test.ts` | new tests |
| `demo/web/src/widget.ts` | render the new failure state (verify only if D2 lands) | optional |
| `packages/plugin/**` | **none expected** | — |

If the implementation starts requiring plugin changes, stop and re-read §3 — it means the
design drifted toward a rejected alternative.

---

## 7. Risks and required guards

| # | Risk | Guard |
|---|---|---|
| R1 | **Reconnect storm.** Every unacked message trips independently → repeated redials. The raw client resets `reconnectAttempts` to 0 on a successful PONG (`:761`), so its own backoff will *not* dampen this. | Escalation backoff must be **per-client, not per-message**, and independent of `retryDelay()`. At most one in-flight recovery cycle at a time. |
| R2 | **Re-entrancy.** This is the entire P0-4 bug class: a synchronous embedder callback (`onSendState`/`onState`) can `close()`/`disconnect()` the client mid-mutation. See the load-bearing comments at `:1889-1905` and `:2206-2219`. | Complete all state mutation and teardown **before** any listener notification. Re-check `disconnected`/`terminalReached`/generation after every callout. |
| R3 | **Terminal instance revival.** `onConnected()` refuses to run on a terminally-retired instance (`:1592-1596`). Escalation must never redial a terminal client. | Gate the trip on `!this.terminalReached && !this.disconnected`, exactly as `armLiveRetryTimer` already does at `:2194`. |
| R4 | **False-positive cost.** A legitimately slow agent (busy-turn buffers, #57) delays ingress ack → needless re-register → duplicate history + approval snapshots to the browser. | Threshold **D1** must exceed worst-case ingress-ack latency by a wide margin. Confirm what that latency actually is under #57 buffering before fixing the number. |
| R5 | **Epoch/generation races.** `onConnected` guards every `await` on `connectionEpoch` (`:1600`), and the retry timer has its own `liveRetryTimerGeneration`. A recovery cycle spans both. | Do not add a third generation counter. Bind the escalation state to the existing epoch and cancel it in `resetSession()`. |
| R6 | **Interaction with #48.** Do not touch the wire parser in this PR. | Scope discipline; #48 is a separate change. |

---

## 8. Verification matrix

All tests belong in `packages/client`, using `FakeNatsWS` + the injected scheduler.
The harness's `registerAgent(...)` server handler is the seam for simulating an agent that
stops acking.

| ID | Scenario | Expected |
|---|---|---|
| T1 | Agent stops acking mid-session; socket stays healthy (relay answers PING/PONG) | Trip fires exactly once at the threshold; **one** `forceReconnect` |
| T2 | After T1's reconnect the agent is healthy again | Re-register succeeds; ledger replays with the **same message ids**; receipt reaches `accepted`; **no duplicate turn** at the agent |
| T3 | Agent stays dead across N recovery cycles | Escalation ceiling reached; `onSendState(id,"failed",…)` fires once; no infinite redial |
| T4 | Multiple unacked messages trip simultaneously | **One** recovery cycle total, not one per message (R1) |
| T5 | Healthy agent, ack merely slow (just under threshold) | **No** reconnect, no duplicate snapshot |
| T6 | `close()`/`disconnect()` called synchronously from the `onSendState` listener during escalation | No stuck `queued` receipt; no post-teardown publish; no timer leak (R2) |
| T7 | Terminal instance (auth-rejected register) with unacked entries | Escalation never redials (R3) |
| T8 | Peer-cap eviction path (§2): agent evicts a live peer, then that peer sends | Same detect → recover → deliver sequence as T1/T2 |
| T9 | Recovery cycle interleaved with a genuine relay drop | Exactly one register flow wins; no abandoned subscription (R5) |
| T10 | Existing suites | `packages/client` full suite still green; no regression in `nats-client-register-recovery.test.ts`, `nats-client-replay.test.ts`, `nats-client-sendstate.test.ts`, `nats-p04-integration.test.ts` |

**Manual/live check (do not skip):** run the local e2e stack, exchange a message, restart
the gateway process only, send again from the widget — the message must arrive without a
page reload. Reproduction steps are in the issue body.

---

## 9. Known gaps this plan deliberately leaves open

### 9.1 Idle tabs
The design is **reactive** — it trips on an unacked send. A tab where the user types
nothing never learns it is muted. Practical impact is limited (the very next send recovers
transparently), but it does mean:
- agent-initiated outbound messages to a muted peer are still lost;
- the typing indicator and other agent-pushed frames are still lost.

Cheapest v1.5 mitigation: trigger a probe/re-register on `visibilitychange`/focus.
Full fix: §3.4's `.ping` subject. **Decide in D4.**

### 9.2 Pre-existing history semantics
A redundant re-register resends a history snapshot. Ordered insertion is handled by the
anchor-cursor merge from #16, but the duplicate-snapshot path deserves an explicit test if
D1's threshold ends up low.

---

## 10. Implementation sequence

1. **Land the failing test first** (T1 + T8) against unmodified `develop` — prove the
   silent mute reproduces in the harness before writing any fix.
2. Add `firstAttemptAt` (if D1 chooses elapsed-time) and the trip predicate in
   `retryDueUnacked()`.
3. Add per-client escalation state (in-flight flag + cycle counter + its own backoff) and
   the `forceReconnect()` call. Verify T1, T2, T4, T5.
4. Add the escalation ceiling → `trackerFail`. Verify T3, T6, T7.
5. Wrapper + type surface for the new failure (D2, D3). Verify T9, T10.
6. Drive-by: correct the stale credential-scope comment at `nats-client.ts:1628-1630`
   (§3.1).
7. Live e2e restart check (§8).
8. Update `docs/gaps/` only if a claim there is contradicted — otherwise leave it alone.

---

## 11. OPEN DECISIONS — settle these before coding

| ID | Decision | Options | Plan author's recommendation |
|---|---|---|---|
| **D1** | Trip threshold | (a) `retryCount >= N`; (b) elapsed `>= T` since first publish; (c) both | **(b)**, with a concrete `T` chosen only after measuring worst-case ingress-ack latency under #57 busy-turn buffering. Do not guess the number. |
| **D2** | Escalation failure surface | (a) new `SendFailure.reason: "unreachable"` (`retryable: true`); (b) reuse `"terminal"` with a new `WebChannelErrorCause`; (c) no receipt failure, connection-status only | **(a)** — the semantics are genuinely new and `"terminal"` carries a "fresh client required" contract that would be a lie here. It is an additive union member on an exported type; confirm the semver expectation for `packages/client`. |
| **D3** | Connection-status behavior during recovery | (a) `"reconnecting"` during stage ②, back to `"connected"`; (b) leave status untouched, receipt-level signal only | **(a)** — it is honest, and the widget already renders it. |
| **D4** | Idle-tab coverage in v1 | (a) out of scope (reactive only); (b) add `visibilitychange` probe; (c) full `.ping` subject | **(a)** for v1. Revisit after the reactive fix ships and real usage shows whether idle muting matters. |
| **D5** | Escalation ceiling | how many failed recovery cycles before `failed` | Needs a number; must be small enough that the user learns within a plausible attention span, large enough to survive an ordinary gateway restart's downtime. |

---

## 12. Appendix — facts a fresh agent would otherwise rediscover the hard way

- **The register hop is two-phase** (nonce challenge then signed proof) —
  `nats-register.ts:383` replies with the nonce; the proof branch continues to `:521`.
  PR #86 (`fix/register-hop-wire-freshness`, protocol v3) recently changed freshness/PoP
  op-scope binding. Read that diff before touching register.
- **Register failure is terminal by design.** `onConnected` tears the whole connection
  down on `isTerminalRegisterError` (`nats-client.ts:1650+`). A mid-session recovery
  attempt that hits a genuine credential failure will therefore terminate the client —
  correct, but make sure T7 pins the behavior.
- **`resetSession()` keeps the unacked ledger on purpose** (`:1506-1507`) and
  `disconnect()` clears it. Replay correctness depends on that asymmetry.
- **Ack is emitted at ingress admission, not turn completion** —
  `packages/plugin/src/nats-account-runtime.ts:962` (`if (outcome === "accepted")
  channel.sendAck(...)`). So ack latency ≈ admission latency, which is what makes it a
  usable liveness signal.
- **`MAX_UNACKED = 100`** (`nats-client.ts:1196`); overflow evicts the oldest with
  `SendFailure.reason: "evicted"`. Escalation must not double-fail an already-evicted id
  (`trackerFail` is idempotent — it returns early when `state === "failed"`, `:2043`).
- **Timers are `unref`'d** (`:2221`) — relevant if a test hangs the Node process.
- **The repo merges feature branches into `develop`**, not `main` (see #76…#86).
- **Multiple worktrees exist for this repo.** `git worktree list` before assuming a stray
  modified file is yours — `issue-87` is live at
  `/Users/mircorn/orca/workspaces/openclaw-webchannel/issue-87`.

---

## 13. Related issues

- **#51** unregister replay — same family (register-hop state assumed stable when it is not); closed.
- **#48** parser O(n²) — do not entangle; blocks the `no_responders` option (§3.3).
- **#72 / #84** credential containment — blocks the broadcast option (§3.1); the #72 runbook
  requires a gateway restart, which is how #81 was found.
- **#57** busy-turn buffers — sets the worst-case ingress-ack latency that D1 must clear.
