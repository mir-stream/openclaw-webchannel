# Issue #57 — Busy-turn buffer hard bounds — Implementation Plan (v4)

> Status: IMPLEMENTED — VERIFICATION COMPLETE AFTER R4 PLAN CONVERGENCE
> Issue: `#57 Bound per-session busy-turn buffers to prevent authenticated gateway OOM`
> Branch: `fix/issue-57-bound-busy-turn-buffers`
>
> Fixed product policy from the pre-plan review:
>
> - preserve already-buffered FIFO work; reject only the newest overflow;
> - per session: **32 logical messages / 1 MiB charged retained bytes**;
> - per OpenClaw process: **1,024 logical messages / 32 MiB charged retained bytes**;
> - the process budget is shared across accounts; there is no per-account partition;
> - overflow is an explicit, id-correlated terminal send failure, never a silent drop;
> - limits are implementation constants in this release, not public configuration.

## 1. Problem and security boundary

`createSerializedInboundDispatcher(..., { coalesce })` currently keeps one running
turn per `sessionKey` and appends every message that arrives during that turn to
`pending: Map<string, Message[]>`. Neither the array length nor the retained
message size is bounded. A valid authenticated peer can hold its current turn
open and publish messages faster than that turn settles. The process retains every
full object and can exhaust the heap shared by all sessions and accounts.

The vulnerable path is:

```text
encrypted NATS user_message
  -> NatsChannel decrypt/dispatch
  -> core inbound debouncer
  -> persistent ingress dedupe
  -> ingress ACK (today: before dispatch)
  -> serialized dispatcher
       running? no  -> start turn
       running? yes -> pending[sessionKey].push(message)  // unbounded
```

The security boundary is one OpenClaw process. Account dispatchers remain
logically separate for routing/FIFO, but all of them consume one shared process
budget because they share one heap and one failure domain.

### 1.1 Required outcome

1. All not-yet-running retained work (debounce waiting/in-flight plus dispatcher
   pending) is bounded simultaneously by count and charged bytes, per session
   and per process.
2. A full session or process rejects the newest not-yet-admitted logical message;
   it never evicts previously accepted work.
3. Every conforming rejected send reaches an id-correlated terminal client state,
   including when the first result frame is lost but both endpoints remain live;
   no overflowed receipt is left at `accepted`.
4. In-bound work preserves FIFO and existing busy-time coalescing.
5. Different sessions continue to execute concurrently.
6. All count/byte accounting is released exactly once on drain, clear, failure,
   cancellation, authenticated peer unregister/peer-cap eviction, and account
   stop/abort teardown.
7. Pressure/rejection is observable through bounded, content-free logging.

### 1.2 Non-goals

- No disk-backed turn queue or crash recovery.
- No inbound rate limiter/token bucket. Rate limiting remains P2-5; this issue
  bounds retained busy-turn work even when a peer is otherwise admitted.
- No account-level quota or reserved share inside one process.
- No public `channels.webchannel.*` limit configuration in this release.
- No change to the one-running-turn-per-session rule.
- No eviction of accepted work, priority messages, or fair scheduling among
  already-buffered sessions.
- No attachment/media wire expansion; the current wire remains text messages.

### 1.3 The bound starts before debounce

Pinned OpenClaw `createInboundDebouncer` also has uncapped `items[]` and per-key
Promise chains. Merely bounding the later dispatcher would leave an equivalent
OOM path while async outcome lookup or a turn is stalled. This implementation
therefore replaces that SDK primitive on the WebChannel ingress path with a
repo-owned `createBoundedInboundDebouncer` that preserves its timer,
same-key-serialization, `onFlush`, `cancelKey`, and `onCancel` behavior while
owning explicit count/byte reservations.

One shared retention budget covers both layers:

```text
debounce waiting/in-flight + dispatcher pending
  <= 32 messages / 1 MiB per session
  <= 1,024 messages / 32 MiB per process
```

A reservation is acquired synchronously before a message or key-chain closure is
created and remains charged while a started `onFlush`/`onCancel` callback can
retain or copy that message, including after peer/account retirement. Fresh
admitted work transfers that same reservation into dispatcher pending without a
release/re-reserve gap; an idle turn releases it immediately before becoming the
uncharged running turn. Duplicate, rejected, cancelled, failed, and torn-down
items release it exactly once after their last physical callback owner settles.
Queued callbacks that never began are severed and released synchronously. Thus a
stalled dedupe store and a never-settling handler cannot move attacker-controlled
retention to an earlier unbounded layer.

## 2. Fixed semantics

### 2.1 Four limits, first failure wins

```ts
export const DEFAULT_BUSY_TURN_LIMITS = {
  maxMessagesPerSession: 32,
  maxBytesPerSession: 1 * 1024 * 1024,
  maxMessagesPerProcess: 1_024,
  maxBytesPerProcess: 32 * 1024 * 1024,
} as const;
```

The count is the number of retained logical `user_message` frames, not the number
of debouncer flushes or coalesced turns. A valid id already present in the bounded
in-flight-id index is not retained twice; a persistent duplicate whose outcome
cache is cold may temporarily own one reservation until async lookup releases it.
A debounce batch therefore cannot bypass the count limit by becoming one object
before dispatcher admission.

Limits cover combined debounce-waiting, debounce-in-flight, and dispatcher-
pending work. The one message/merged batch currently running is not charged. A
large message may start when a session is idle but be rejected while a retained
slot is unavailable; this is intentional because only not-yet-running objects
need the hard retention budget.

When more than one limit would fail, the internal rejection classifier uses this
stable order for tests/logging:

1. `session-message-count`
2. `session-byte-count`
3. `process-message-count`
4. `process-byte-count`

The wire intentionally collapses these operational details to `overloaded`.

### 2.2 Prefix admission and tail rejection

Admission operates synchronously on each ordered frame before debounce storage
or coalescing. Already-retained reservations are never evicted: the first frame
that cannot fit is overflowed, while a later frame is considered only against
capacity actually released in the meantime. For the dispatcher's batch/lease
compatibility API, it accepts the longest prefix that fits every limit and
rejects the remaining suffix; it never skips a large failing item to admit a
later small item from that same call.

Example at a session count of 31:

```text
incoming fresh batch [m32, m33, m34]
accepted             [m32]
rejected                  [m33, m34]
```

Previously buffered entries stay byte-for-byte and order-for-order intact. A
process-limit rejection in account B cannot evict account A, and a session-limit
rejection cannot touch another session.

### 2.3 Retained-byte charge

The budget is a conservative charge, not a claim to measure V8 heap bytes
exactly. For each valid retained message:

```text
charge = UTF-8 bytes of JSON.stringify(message)
       + fixed per-message overhead
       + the future "\n\n" coalesce separator where applicable
```

The fixed overhead is **256 bytes per logical message**. It covers the array
slot, object/string headers, and accounting metadata under the current text wire.
`JSON.stringify` includes unknown enumerable fields if a nonconforming peer sends
them, so the charge cannot be bypassed by hiding a large value outside `text`.
Parsed JSON cannot be cyclic; an unexpected stringify failure rejects that item
as overloaded/fail-closed and logs metadata only.

The implementation exports/injects the measurement function so unit tests use
small exact byte values without allocating MiB fixtures. Production uses the
real estimator above. Count and bytes must be finite non-negative safe integers;
invalid injected values throw at dispatcher construction.

At drain, creating the merged string briefly overlaps the bounded source strings.
That transient copy is therefore also bounded (at most the configured pending
bytes plus one merged copy), but only the retained pending source objects are
charged. The plan and logs must say “charged retained bytes,” not “exact heap.”

## 3. Wire and send-result contract

### 3.1 New terminal frame

Plugin to client:

```ts
type InboundRejectedFrame = {
  type: "inbound_rejected";
  ids: string[];
  reason: "overloaded";
};
```

`ids` contains only valid source ids whose recorded outcome is `overloaded`. It
never contains an id whose outcome is `accepted`. Repeated identical results are
allowed across frames so the implementation does not need an attacker-sized
whole-flush `Set`; each individual frame deduplicates ids in arrival order and
the client consumes all results idempotently. The frame carries no message text,
byte size, limit, peer id, or account id.

ACK and rejection use one shared bounded result-frame chunker:

```ts
const MAX_INGRESS_RESULT_IDS = 64;
const MAX_INGRESS_RESULT_WIRE_BYTES = 64 * 1024;
```

The chunker measures actual UTF-8 JSON plus the exact fixed-overhead AEAD/base64
wire-size formula before publishing, flushes before either bound is crossed, and
retains at most one chunk of ids. Its effective byte limit is the minimum of
64 KiB, the local 8 MiB safety ceiling, and the authenticated NATS server's
advertised `INFO.max_payload`. `NatsTransport.publish`/`publishWithReply` enforce
that effective outbound ceiling before writing any part of `PUB`, and the actual
sealed byte length is checked again at publish. A configured server ceiling too
small for one valid id yields no partial frame, a rate-limited configuration
error, and client retry rather than an oversized write. Rejected suffixes and
duplicate ACKs are streamed through this chunker rather than first being mapped
into one unbounded id array.

The low-level client handles the frame before notifying ordinary message
listeners:

1. delete each id from `unackedLedger` (the rejection is a terminal ingress
   outcome, so reconnect must not auto-replay it);
2. transition the matching tracker to
   `failed { reason: "overloaded", retryable: true, lastAttemptAt }`;
3. ignore unknown, duplicate, or already-terminal ids;
4. forward the frame to listeners; the wrapper reducer case is a no-op because
   the authoritative low-level send tracker already emitted the transition.

`retryable: true` means an application may offer a fresh user-directed resend
later. Neither low-level client nor wrapper automatically retries an overloaded
message, avoiding an overload feedback loop.

### 3.2 ACK means admitted, rejection replaces ACK

The current `createIngressOnFlush` ACKs all ids before dedupe/dispatch. That order
must change. For each valid input id there is exactly one ingress outcome
**class**. The same class may be replayed more than once until the client consumes
it, but ACK and rejection are mutually exclusive for an id:

| classification | server result |
|---|---|
| previously accepted duplicate | `ack` |
| fresh and admitted (running or buffered) | `ack` |
| fresh but over limit | `inbound_rejected` |
| previously overload-rejected replay | `inbound_rejected` |

A rejected id is **not** included in `ack`, including when the same fresh id
appears twice inside one flush. This removes the false intermediate `accepted`
state and keeps the unacked ledger available for recovery if the rejection
publish itself is lost.

### 3.3 Outcome-aware replay/dedupe

The current boolean “seen” record cannot distinguish an admitted id from a
rejected id. The implementation replaces direct `checkAndRecord` use at this
seam with an `IngressOutcomeStore` whose logical value is one of:

```ts
type IngressOutcome = "accepted" | "overloaded";
type OutcomeLookup =
  | { status: "found"; outcome: IngressOutcome }
  | { status: "not-found" }
  | { status: "unknown"; error: unknown };
```

The adapter uses mutually exclusive accepted/overloaded keys backed by two
**process-wide** pinned `createPersistentDedupe` instances:

```text
accepted store            = existing persistent-dedupe namespace family
overloaded store          = webchannel-inbound-overloaded namespace family
logical namespace         = accountId (routing isolation, not a resource quota)
TTL / shared memory caps  = 7d / 2,048 per store across the process
disk state cap            = 5,000 per SDK namespace
```

An id is written to **exactly one** namespace, only after capacity admission has
selected its outcome. A rejection is never pre-recorded as ordinary/accepted.
Lookup checks overloaded first and accepted second. If both exist because of
legacy/corrupt state, overloaded wins, a rate-limited invariant warning fires,
and accepted is forgotten best-effort. This precedence prevents a false ACK.

The SDK swallows disk errors and otherwise makes `hasRecent(false)` ambiguous.
The adapter therefore observes its `onDiskError` epoch around every call. A
negative lookup accompanied by a new disk error is `unknown`, not `not-found`;
classification stops for that item, emits neither ACK nor rejection, and relies
on the bounded client retry in §3.5. A positive memory hit remains authoritative.
Cross-operation false positives caused by another concurrent disk fault are
safe: they delay an outcome but cannot admit or ACK the wrong one.

For the synchronous pre-debounce fast path, `IngressOutcomeStore.peek(accountId,
key)` uses one process-wide insertion-ordered hot cache capped by both 2,048
entries and 2 MiB of measured UTF-8 namespace/key metadata. It contains only
accepted outcomes actually used in this process and **durable** overload
outcomes. Eviction merely falls back to bounded async lookup/resolution; it never
changes the recorded outcome. Account id is part of every cache key so one
account can never resolve another's id, but all accounts compete for the same
entry/byte budget with no reserved share. This cache is not a storage-failure
fallback and zero/evicted entries carry no authority.

Processing is sequential in arrival order and records the chosen outcome before
advancing to the next retained item. A bounded synchronous in-flight-id index is
populated at pre-debounce admission; a repeated `[id=x]` while the first `x` is
retained creates neither a second reservation nor an overflow outcome task. The
first copy remains authoritative and eventually supplies the shared client
ledger id's ACK/rejection. Whole-flush outcome maps are unnecessary.

The first unresolved persistent classification is also a same-flush FIFO
barrier. This includes an explicit `unknown`, a thrown lookup/record operation,
an unresolved overload record, or a cancellation-fallback retry without a
publishable outcome. The already-classified prefix commits in order, while the
unresolved current item and every unclassified suffix item release their
reservations without another lookup, record, offer, result, or dispatch. Their
client-ledger retries resume classification later; a storage fault can delay a
suffix but cannot let it overtake the unresolved item.

Record results also expose durability:

```ts
type OutcomeRecordResult =
  | { status: "recorded"; durability: "durable" | "memory-only" }
  | { status: "unknown"; error: unknown };
```

Accepted outcomes preserve the existing fail-open behavior: a disk-write fault
may record in the SDK's bounded memory tier and ACK admitted work, with the
existing documented duplicate-after-restart degradation. Overloaded outcomes
are stricter: `inbound_rejected` is emitted **only** after a durable write. If
`onDiskError` advances during overload recording, the adapter immediately calls
`forget` (which clears the SDK memory entry before its best-effort disk delete),
emits no terminal result, and lets the client retry. A durable overload marker
survives a crash after record but before publish; a delivered rejection already
gave the client its terminal state. Thus every restart ordering has at least one
recovery owner and a memory-only rejection is never mistaken for durable state.
Cancellation-fallback recovery uses `record(accepted, { replaceOpposite: true })`.
The opposite-store delete observes its own `onDiskError`; if a durable overload
may remain, replacement returns `unknown`, releases the per-key gate, keeps the
fallback, and emits no ACK. This prevents a dual marker whose later lookup would
otherwise choose overload.

An accepted/overloaded write receipt retains its per-key operation gate until
`commit()` or `rollback()`. Rollback observes the SDK `forget(...).onDiskError`
hook. If exact deletion fails, the marker is placed in a separate process-wide
rollback-recovery quarantine capped at **2,048 entries / 2 MiB** of measured
account/key metadata and removed from synchronous hot classification. Later
`lookup`, `record`, or `forget` for that key first retries deletion of the exact
marker generation under the same key gate. Until cleanup succeeds it returns
`unknown`, so a same-process cold lookup cannot rediscover the stale marker and
ACK/reject work whose dispatcher offer was rolled back. Once deletion succeeds,
classification resumes from `not-found` and the retry may be freshly admitted.

Quarantine entries are never evicted to make room, because eviction would forget
known-unsafe state. If its count/byte bound cannot accept another failed marker,
one bounded process poison latch makes every later outcome operation `unknown`
for the life of that process. This deliberately harsh fail-closed behavior keeps
storage failures from creating an unbounded map/task/Promise family or silently
authorizing lost work. This recovery metadata is live-process state, not crash
recovery: a process restart still has the record-before-result tradeoff documented
above and §1.2's disk-backed/crash-recovery non-goal remains unchanged. Unexpected
adapter exceptions likewise return `unknown` and emit no result.

### 3.4 Protocol v2 is enforced in both directions

`WEBCHANNEL_PROTOCOL_VERSION` becomes `2` in plugin and client. The new plugin
must also validate the `protocolVersion` already sent in the client's `register`
request; checking only the plugin's reply protects a new client from an old
plugin but does not stop an old client from connecting to a v2 plugin and
ignoring `inbound_rejected`.

Register rules:

- request `protocolVersion !== 2`, absent, non-integer -> terminal
  `{ error:"protocol_mismatch", code:426, protocolVersion:2 }`;
- matching request -> normal register success with reply `protocolVersion:2`;
- new client treats missing reply version as terminal; the previous pre-v1
  tolerance is removed because it defeats the v2 result contract;
- mismatch/malformed/missing all map to client cause `protocol-mismatch` and do
  not establish a conversation key/session.

The check occurs only after JWT/subject/tenant verification, so the register
reply does not become a useful unauthenticated account oracle. Challenge remains
version-agnostic; the version gate is on `op:"register"` where the client already
sends the field.

### 3.5 Live pre-outcome retry

Reconnect-only ledger replay is insufficient: the agent's outbound connection
can lose a rejection while the browser stays continuously connected. The client
therefore retries every published-but-unresolved `user_message` with the **same
id** while the session is ready, until ACK/rejection, explicit close, terminal
connection failure, or ledger eviction.

- one timer services the existing bounded `MAX_UNACKED = 100` ledger;
- retry delay is exponential `1s, 2s, 4s, 8s, ...`, capped at 30s, with bounded
  jitter; tests inject the clock/random source;
- retry republishes only due entries, preserves ledger insertion order, and
  never emits another `sent` transition; it updates the tracker's
  `lastAttemptAt`;
- disconnect/reset cancels the live timer and existing reconnect replay remains
  the immediate recovery path after a new session is established;
- receiving ACK or `inbound_rejected` deletes the ledger entry and re-arms the
  timer for the next due id;
- after `failed(overloaded)` there is no ledger entry, so there is no automatic
  retry. A user-directed retry still creates a new id.

This is reliability replay before any terminal ingress outcome, not an automatic
resend of rejected work. Server outcome dedupe makes every retry idempotent and
ensures an agent-only outbound reconnect can deliver the previously lost result.

## 4. Retention and dispatcher design

### 4.1 Shared reservation ownership

Replace raw `Message[]` pending values with entries carrying one transferable
reservation:

```ts
type RetentionOwner = "debounce-waiting" | "debounce-inflight" | "pending";

type RetentionReservation = {
  sessionToken: symbol;
  chargedBytes: number;
  owner: RetentionOwner;
  transfer(next: RetentionOwner): void;
  release(): void;
};

type RetainedEntry<Message> = {
  message: Message;
  id?: string;
  reservation: RetentionReservation;
};

type SessionUsage = { messages: number; bytes: number };
type ProcessUsage = { messages: number; bytes: number };
```

One module-scope `InboundRetentionBudget` owns all session and process usage and
is injected into every account's bounded debouncer and dispatcher. Each account
dispatcher mints a stable session token per peer, so the same textual peer id in
two accounts has separate session caps without creating an account quota. The
budget contains process usage and the four fixed limits, but no account share.

### 4.2 Bounded debounce and overflow resolution

`createBoundedInboundDebouncer` mirrors the pinned SDK behavior but changes
`push(item)` to synchronously return one of `accepted`, `duplicate-inflight`,
`overflow`, or `disposed`. Before reserving, it checks two bounded synchronous
indexes:

1. a hot outcome cache can immediately replay a known ACK/rejection;
2. an in-flight-id index drops a repeated valid id without another reservation;
   the earlier copy owns and will publish that id's outcome.

For a new/id-less frame, `push` measures and reserves before creating a timer,
array entry, Promise continuation, or callback closure. The reservation moves
from `debounce-waiting` to `debounce-inflight` when flush begins and is retained
until outcome classification either releases it or transfers it to dispatcher
pending. Non-zero debounce batching and zero-ms same-key serialization therefore
share the same bound.

`cancelKey(key, { notify })` detaches synchronously. `/stop` uses `notify:true`:
its existing record-cancelled/ACK callback may be async, so reservations remain
charged until that callback settles. Peer unregister/account disposal use
`notify:false` and invalidate the generation. Waiting and detached callbacks that
never began are severed and released immediately. A callback that already began
may have copied its entries before its first await, so its reservation remains
charged until the callback settles even though all later delivery/dispatch is
revoked. This makes repeated cross-key teardown churn consume the same hard
process count/byte budget instead of creating an uncharged async fan-out.

A raw overflow cannot synchronously distinguish an accepted replay from a fresh
id when the persistent cache is cold. The exception is the synchronous bounded
cancelled-item fallback: it is authoritative before the hot outcome cache and
marks the existing no-wait task as accepted-recovery. Raw overflow is handled by
a process-wide `BoundedOverflowResolver`:

- at most one active resolver per session, 64 per process, and 1 MiB of measured
  process-wide resolver metadata; there is no waiting queue, so a failed
  `tryStart` retains nothing and the client's live retry is the recovery path;
- an active task retains only bounded routing/key/id metadata, never message
  text/object; UTF-8 route/key/id bytes plus fixed overhead are charged against
  the separate 1 MiB resolver-metadata ceiling;
- it performs full outcome lookup: accepted -> ACK, overloaded -> rejection,
  not-found -> record overloaded durably -> rejection;
- in accepted-recovery mode it skips ordinary lookup, records accepted with
  opposite replacement, sends only ACK, and deletes the fallback only after
  record+ACK succeed while the task remains active;
- unknown/read/write failure emits no result. A memory-only overload write is
  forgotten as specified in §3.3 and the same-id client retry tries again;
- session/account teardown invalidates the task generation so a late completion
  cannot publish or mutate a replacement runtime.

This resolver preserves first-arrival semantics: a later duplicate can never
poison an earlier retained copy because the in-flight-id index catches it before
the overflow path. Saturating resolver slots cannot increase memory; it only
delays terminal results until conforming clients retry.

### 4.3 Streaming dispatcher lease

`createIngressOnFlush` must stop coalescing fresh frames before queue admission,
but it must also avoid building an unbounded rejected-id array. The dispatcher
therefore exposes a streaming batch lease:

```ts
const lease = dispatcher.beginBatch(sessionKey);
const offer = lease.offer(message, reservation);
// offer.status: "accepted" | "rejected" | "disposed"
// accepted offers are provisional until offer.commit(); offer.rollback()
// releases their reservation. lease.finish() starts/drains committed work.
```

Ingress walks retained debounce entries in arrival order. Known accepted/
overloaded outcomes release the reservation and emit their prior result. For a
fresh entry it calls `offer` with the existing reservation, records `accepted`,
then commits or rolls back that offer and feeds the id into the bounded result
chunker. `lease.finish()` runs in `finally`, so an exception cannot strand
provisional accounting.

`dispatch(sessionKey, message)` remains as a one-element compatibility wrapper
for legacy/no-coalesce callers and existing tests. In coalesce mode:

- idle session: the lease owns the accepted batch until `finish`, then coalesces
  and starts it as one uncharged running turn, releasing its reservations;
- busy session: `offer` transfers each retained reservation to `pending` without
  changing combined session/process usage;
- direct/legacy callers without a reservation still use the dispatcher's own
  longest-prefix check-and-reserve path as defense in depth;
- running settlement while a lease is open marks the session ready-to-drain but
  waits for `finish`, preventing outcome persistence from racing the drain;
- `finish` atomically detaches/releases the committed pending entries as needed,
  coalesces them, and starts the next turn; later arrivals form a new wave.

Capacity check/reservation at debouncer push and reservation adoption at offer
each happen synchronously in one JS call stack. No `await`, logger, handler, or
user callback can observe a release/re-reserve gap or overbook the shared budget.
The accepted outcome is recorded before its offer is committed/result is sent;
overloaded work never enters the dispatcher. ACK may precede `finish` because a
committed lease reservation is ingress admission; a process crash before handler
start remains the pre-existing documented record-to-start at-most-once window.

If `/stop` or teardown invalidates a batch while outcome work is stalled, ingress
does not await any per-item cancellation callback from inside the classification
loop. Its invalidated footer first rolls back every held outcome receipt, thereby
releasing all per-key storage gates; only then does it await requested
cancellation persistence, roll back provisional offers, and release deferred
reservations. The still-running debounce callback remains physically charged
until that sequence settles. This prevents a cancellation replacement write from
waiting behind a gate held by the same flush while preserving the hard retention
bound and suppressing every late normal ACK/dispatch.

### 4.4 Accounting ownership

Every retained entry has exactly one owner transition:

```text
unowned -> debounce-waiting reserved -> debounce-inflight
debounce-inflight queued -> duplicate/rejected/error/cancel/dispose -> released
debounce-inflight running callback -> invalidated but charged -> callback settled -> released
debounce-inflight -> provisional dispatcher offer
provisional -> rollback/clear/dispose -> released
provisional -> committed pending (ownership transfer, usage unchanged)
committed pending -> detached/clear/dispose -> released
debounce-inflight/provisional -> uncharged running -> released before start
```

The running turn is never an accounting owner. Handler resolve, reject, and
synchronous throw all reach the same settled drain. Releasing usage clamps
nothing silently: underflow is an invariant violation in tests/development and
must throw from the pure budget helper. Production call sites are arranged so
release is exactly once rather than hiding double-release.

`clearPending(sessionKey)` returns the actual dropped `Message[]`, not only a
count, so callers can correlate a deliberate `/stop` drop if/when that path is
given a terminal cancellation outcome. Issue #57 requires accounting release;
changing the pre-existing `/stop` receipt semantics is kept separate from the
overflow wire frame in this patch because `inbound_rejected.reason` is
deliberately overload-only.

Dispatcher `dispose()` releases every pending/provisional entry and closes active
leases. Bounded-debouncer `dispose()` releases waiting/queued entries without
`onCancel` fanout and marks started callbacks inert; those callbacks and any
entries they copied remain reported and charged until their `finally` settles.
Both return summaries for tests/logging. They are idempotent and terminal: later
push/beginBatch/dispatch calls return `disposed` without retaining or starting a
handler. The pinned OpenClaw gateway adapter exposes both `stopAccount(ctx)` and
`ctx.abortSignal`; §5.3 makes start acquire an exact runtime-generation lease and
wires stop/abort to identity-safe disposal. Transient NATS disconnect/reconnect
must **not** dispose or clear retained work because that would destroy
already-admitted work during a network flap.

### 4.5 Drain ordering and the no-id case

Accepted entries are coalesced in arrival order. The merged turn continues to
use the last accepted message id as `turnId`; a rejected suffix id can never
become the anchor.

Protocol-v2 clients always mint a short id. The server keeps the existing
backward-hardening behavior for a nonconforming id-less message: it may execute
if admitted, but if it overflows there is no correlatable receipt, so it is
dropped and included only in aggregate logging. It must still consume/release
count and byte budget like any other message while pending.

## 5. Integration changes by file

### 5.1 Retention budget, bounded debounce, and dispatcher

`packages/plugin/src/inbound-retention.ts`

- define/export the four fixed limits, usage, internal reason, estimator,
  reservation owner, and process-wide `InboundRetentionBudget` types;
- implement synchronous reserve/transfer/release with safe-integer validation,
  exact underflow checks, and diagnostic snapshots;
- mint opaque session tokens so per-session usage is account-route-correct while
  process totals remain unpartitioned; delete zero-usage session records so peer
  churn cannot grow the budget map.

`packages/plugin/src/bounded-inbound-debouncer.ts`

- mirror the pinned SDK debounce/timer/same-key serialization behavior;
- reserve before retaining any item/closure and hold the token across async
  `onFlush` settlement;
- accept a typed measurement seam and make production pass
  `estimateRetainedMessageBytes(item.message)`, excluding the repo-owned
  `{peerId, message}` routing wrapper from the fixed wire-message charge;
- maintain bounded hot-outcome and in-flight-id checks, cancel/release per key,
  terminal idempotent `dispose`, and generation guards for late continuations;
- expose deterministic clock/timer hooks for exact boundary and stalled-flush
  tests.

`packages/plugin/src/inbound-overflow-resolver.ts`

- implement the no-wait process-wide 64-task/1-MiB/per-session-1 resolver gate;
- retain only bounded routing/id metadata and resolve cached/persisted outcomes;
- require durable overload recording before sending terminal rejection;
- invalidate late tasks on peer/account teardown without leaking a slot.

`packages/plugin/src/inbound-queue.ts`

- replace raw pending arrays with reservation-owning `RetainedEntry[]`;
- implement the streaming admission lease, prefix admission, exact
  adopt/release, disposed latch, and `dispose`;
- return dropped messages from `clearPending`;
- retain the legacy no-coalesce promise-chain behavior unchanged.

`packages/plugin/src/inbound-retention.test.ts`,
`packages/plugin/src/bounded-inbound-debouncer.test.ts`,
`packages/plugin/src/inbound-overflow-resolver.test.ts`,
`packages/plugin/src/inbound-queue.test.ts`

- retain all existing debounce/FIFO/throw/coalesce semantics tests;
- add exact combined count/byte/global boundary, stalled async flush, resolver,
  transfer, and lifecycle matrices (§7).

### 5.2 Ingress outcome ordering

`packages/plugin/src/ingress-outcome.ts`

- wrap two process-wide accepted/overloaded persistent dedupe instances behind
  the account-namespaced tri-state `IngressOutcomeStore` API;
- expose a synchronous process-wide 2,048-entry/2-MiB hot index containing
  accepted and durable-overloaded outcomes for pre-debounce classification;
- record exactly one selected outcome per fresh id and make overload win if an
  impossible dual marker is observed;
- turn `onDiskError` epochs into conservative `unknown` lookup results;
- report record durability and forget a memory-only overload before returning
  `unknown`, so callers cannot publish a non-durable terminal rejection;
- retain failed receipt rollbacks in one bounded process-wide 2,048-entry/2-MiB
  exact-marker quarantine; retry cleanup before hot/cold classification and
  poison the process store fail-closed if recovery metadata cannot fit;
- expose no raw boolean whose `false` could mean either absence or storage
  failure; unexpected exceptions and pending rollback cleanup return `unknown`.

`packages/plugin/src/ingress-dedupe.ts`

- replace pre-dispatch ordinary recording with sequential outcome lookup,
  reservation adoption, accepted-outcome record, and offer commit/rollback;
- treat the first unknown/thrown lookup or record, unresolved overload record,
  or cancellation-fallback retry without a publishable outcome as a FIFO
  barrier: finalize the classified prefix, then release the current item and
  untouched suffix for ledger retry without further classification or results;
- on mid-flush invalidation, roll back all held outcome receipts/key gates before
  awaiting cancellation callbacks, then roll back offers/releases so physical
  accounting stays charged until cancellation settles without a self-deadlock;
- stream ACK/rejection ids through a shared count+sealed-wire-byte chunker;
- ACK only accepted outcomes and reject only overloaded outcomes, including
  repeated ids in the same flush;
- preserve cancelled-item semantics while moving its fallback tombstones to one
  account-namespaced process-wide 256-entry/256-KiB insertion-ordered store;
- give that fallback precedence over hot outcomes/admission and carry one mode
  bit through the existing bounded overflow resolver rather than adding a queue.

`packages/plugin/src/ingress-outcome.test.ts`,
`packages/plugin/src/ingress-dedupe.test.ts`

- assert exact offer -> outcome-record -> offer-commit -> result order;
- add same-id, replay, unknown-storage, and mixed
  duplicate/fresh/partial-admission cases;
- prove lookup-unknown, accepted-record-unknown, and overload-record-unknown each
  commit the classified prefix while leaving the suffix wholly untouched;
- prove multi-item `/stop` releases every held outcome gate before awaiting
  cancellation persistence, converges accounting, and emits no late normal
  ACK/dispatch;
- cover accepted and overloaded rollback-delete failure, same-process cold replay
  suppression, later exact cleanup/fresh classification, and recovery-cap poison;
- use real hermetic persistent dedupe instances for accepted and overloaded
  namespaces to prove namespace separation and precedence.

`packages/plugin/src/ingress-result-chunks.ts`

- implement one bounded streaming chunk builder shared by ACK and rejection;
- enforce count plus estimated sealed-wire/effective-server byte limits without
  retaining a whole-flush id set.

### 5.3 NATS wiring

`packages/plugin/src/nats-account-runtime.ts`

- create one process retention budget and one overflow-resolver gate at module
  scope, outside every host-selected per-account lifecycle;
- inject the same budget into every account bounded debouncer and dispatcher;
- create one process-wide `IngressOutcomeStore`; pass accountId only as the
  logical persistent/cache namespace, never as a resource partition;
- wire the dispatcher lease, outcome store, bounded result writers, and
  `sendInboundRejected` into the typed helper;
- keep `/stop` clear wiring, now consuming dropped messages and releasing usage;
- retain the bounded debouncer, dispatcher, overflow-resolver generation, and
  transport teardown handles in `AccountRuntime`;
- preserve the existing `NatsAccountRuntimeCoordinator`: `registerFull` remains
  synchronous/network-free and the host starts only its selected account;
- fold bounded-ingress cleanup into the coordinator-owned, exact-generation
  disposer before channel/listener/graceful-transport teardown;
- guard the final no-await register-subscription/map-publication boundary with
  the coordinator owner/abort generation so a stopped stale build closes locally
  and never becomes observable;
- aggregate pressure logs without message contents.

`packages/plugin/src/channel-contract.ts`, `packages/plugin/src/nats-channel.ts`

- add `inbound_rejected` to the outbound union;
- add `sendInboundRejected(peerId, ids)`; empty ids are a successful no-op;
- add a peer-unregister lifecycle callback used by explicit unregister and
  oldest-peer cap eviction; it cancels/releases that peer's bounded-debounce and
  dispatcher entries and invalidates its overflow task before channel key/window
  cleanup;
- continue sealing/publishing over the ordinary per-peer `.out` subject.

`packages/plugin/src/channel.ts`

- keep `gateway.startAccount(ctx)` composed from the approval monitor and the
  coordinator-backed NATS account lifecycle under one child abort signal;
- await both lifecycle cleanups on host abort and abort the sibling if either
  exits unexpectedly;
- account disposal terminally disposes the bounded debouncer and dispatcher,
  invalidates overflow tasks, gracefully closes transport, removes only the exact
  owned runtime, and reselects/clears the lazy primary channel;
- peer/account teardown never disposes the process-wide budget itself; it only
  releases entries owned by that peer/account. Transient reconnect does neither.

`packages/plugin/src/nats-transport.ts`

- parse and retain valid `INFO.max_payload`, combine it with the local 8 MiB
  ceiling, and expose the effective outbound limit;
- enforce that limit in `publish`/`publishWithReply` before sending the PUB
  header so an oversized frame cannot corrupt the stream.

`index-nats.ts` remains a thin re-export with no lifecycle ownership.
`nats-account-runtime.ts` and the nontrivial state machines are included in the
plugin typecheck and covered by runtime/helper tests. Update
`index-nats-wiring.test.ts` source guards so a future wiring edit cannot silently
restore pre-dispatch ACK, create one process budget per account, or publish a
stale account generation.

### 5.4 Client result state

`packages/client/src/types.ts`

- add `"overloaded"` to `SendFailure.reason` and document it as retryable,
  caller-directed only.

`packages/client/src/nats-client.ts`

- add `inbound_rejected` to `InboundMessage`;
- for ACK and rejection frames, detach every unique id and cancel retry ownership
  before the first public tracker callback, then apply accepted/overloaded states
  in frame order so callback-driven disconnect/reconnect cannot fail later ids;
- preserve `lastAttemptAt`;
- unknown/post-terminal rejection is a no-op;
- replace ledger values with bounded retry metadata and drive same-id live
  pre-outcome retries from one injected-clock timer (§3.5).

`packages/client/src/nats-client-wrapper.ts`

- add a no-op reducer case for `inbound_rejected`, parallel to `ack`;
- rely on `onSendState` for the bubble/receipt failure transition;
- do not clear `isTyping` or drafts: a rejected queued send is not a turn settle.

### 5.5 Protocol/register and documentation

- bump both `packages/{plugin,client}/src/protocol.ts` constants to 2;
- validate client request version in `nats-register.ts`;
- make missing reply version terminal in `pop-register.ts`/client registration;
- update protocol lockstep, register mismatch, package export, and fixed-value tests;
- update plugin/client changelogs and README send-state documentation;
- update the gap/status document if it enumerates wire frames or queue semantics.

No package version is bumped in this implementation PR; release automation owns
the lockstep package-version bump/tag. Changelogs must mark protocol v2 as
breaking and say client/plugin must upgrade together.

## 6. Logging and diagnostics

There is no general metrics registry on the current plugin surface. The
acceptance criterion is met with rate-limited structured logging plus pure usage
accessors for tests/diagnostics.

On overflow, emit at most one warning per `(accountId, internalReason)` per 60
seconds. The first event logs immediately; the next allowed event includes the
number of suppressed batches/messages. The limiter key is never `peerId`, so an
attacker cannot grow a per-peer log-state map.

Allowed fields:

```text
accountId, internalReason,
rejectedMessages, rejectedChargedBytes,
sessionRetainedMessages/sessionRetainedBytes,
processRetainedMessages/processRetainedBytes,
debounceWaiting/debounceInflight/dispatcherPending breakdown,
configured limits, suppressed count
```

Forbidden fields:

```text
message text, message ids, ciphertext/plaintext, arbitrary message object,
JWT/subject token, peerId
```

Successful recovery below 80% emits nothing. No timer is required; the next
pressure event flushes suppressed counts, and all timestamps/maps are bounded by
configured account count x four internal reasons.

## 7. Verification matrix

### 7.1 Retention/debounce/dispatcher tests

1. **Count exact boundary:** a stalled zero-ms `onFlush` plus 32 retained frames
   fills the session; the 33rd retains no object/closure and usage stays 32.
2. **Byte exact boundary:** injected charges across debounce-inflight + pending
   exactly fill 1 MiB; +1 byte retains nothing and rejects. A production-shaped
   `{peerId,message}` debouncer item whose message formula is exactly 1 MiB is
   admitted, proving routing-wrapper bytes are not charged.
3. **Single oversize:** one message above the session byte limit is rejected
   before any timer/array/Promise-chain allocation or usage mutation.
4. **Non-zero debounce:** a stopped fake clock cannot grow `items[]` beyond the
   same count/byte caps; flush order/coalescing matches the pinned SDK behavior.
5. **Zero-ms callback bounds:** a never-settling first flush plus an arbitrary
   same-key push loop proves queued entries/continuations stay bounded. A second
   adversarial loop starts callbacks for distinct keys, copies entries before the
   first await, retires every key, and proves exact process count/byte caps, +1
   retains/starts nothing, and settlement releases without late dispatch.
6. **In-flight duplicate:** a repeated valid id owns no second reservation and
   cannot enter overflow resolution; the earlier entry remains authoritative.
7. **Reservation transfer:** debounce-inflight -> pending changes ownership with
   no usage dip/double charge; idle start releases immediately before handler.
8. **Prefix split/direct path:** a direct dispatcher batch accepts its longest
   fitting prefix, tail-rejects without skipping, and keeps order.
9. **Process count:** sessions across dispatcher/debouncer instances sharing one
   process budget reach 1,024 exactly; +1 retains nothing and evicts nothing.
10. **Process bytes:** same for 32 MiB with deterministic injected charges.
11. **Per-session isolation:** full s1 does not prevent s2 unless the process
    limit itself is full; neither can evict the other.
12. **Account-neutral sharing:** same peer id in two accounts has separate opaque
    session tokens/caps but consumes the same unpartitioned process budget.
13. **Drain:** settling the running turn detaches the buffered prefix, releases
    all usage once, and starts one follow-up with the latest accepted id.
14. **Throw/sync throw:** flush/handler rejection or synchronous throw releases
    and does not wedge the next wave/key chain.
15. **Clear:** `/stop` cancel+clear returns exact messages, holds reservations
    through async cancel-record/ACK, then releases both layers; unregister/
    teardown skips that fanout, severs callbacks that never began, and keeps any
    started callback charged until settlement without starting cleared work.
16. **Dispose:** multiple waiting/in-flight/pending sessions release severable
    work immediately; started callbacks remain reported/charged and converge to
    global zero on settlement. Repeated dispose is mutation-idempotent, and late
    continuations/post-dispose pushes cannot reserve, publish, or start work.
17. **Lease settlement race:** the running turn settles while outcome recording
    is awaited; drain waits for `finish`, then releases and starts exactly once.
18. **Offer rollback:** outcome-record failure rolls back its reservation once
    without disturbing earlier committed offers.
19. **Cancellation gate ordering:** multi-item `/stop` rolls back every held
    outcome receipt before awaiting cancellation persistence, cannot deadlock on
    its own per-key gates, keeps usage charged until settlement, and emits no
    late normal ACK/dispatch.
20. **Reentrant burst:** logging/result callbacks entering another session cannot
    observe or create usage above any limit.
21. **Legacy path:** no-coalesce FIFO behavior remains unchanged for callers that
    bypass the bounded debouncer.

### 7.2 Ingress/dedupe/result tests

1. Existing accepted duplicate -> ACK, no dispatch, no budget.
2. Existing overloaded id -> rejection, no ordinary ACK/dedupe/dispatch.
3. Fresh accepted -> reserved offer, accepted outcome record, offer commit, ACK;
   exact order and reservation transfer are asserted.
4. Fresh raw overflow -> bounded resolver, durable overload-only record,
   rejection; accepted storage/dispatcher are never touched.
5. Rejection-send failure -> no ACK; replay consults overload marker and retries
   rejection rather than executing or falsely ACKing.
6. ACK-send failure -> replay hits ordinary duplicate and retries ACK.
7. Mixed batch `[accepted duplicate, overloaded replay, fresh-fit,
   fresh-overflow]` produces disjoint exact id sets and one fitting dispatch.
8. `[fresh x, same-id x]` with the first retained produces one eventual outcome;
   the duplicate cannot overflow-poison or ACK/reject independently.
9. Selective overloaded-lookup/record disk faults with a healthy accepted store
   produce `unknown`; a memory-only overload is forgotten and emits no terminal
   result. Recovery and same-id retry later persist before rejecting.
10. Impossible dual markers choose overloaded and forget accepted best-effort.
11. Hundreds of logical accounts fill one shared hot index to exactly 2,048
    entries/2 MiB; +1 evicts oldest globally, preserves account namespace
    isolation, and falls back to bounded async lookup without growing memory.
12. Overflow resolver enforces one task/session plus 64-task/1-MiB process caps
    with no queue; saturation retains no message object and retry can later win.
13. Crash/restart at overload memory-write error, durable record, publish, and
    client receipt proves either ledger replay or terminal client state always
    owns recovery; no memory-only terminal rejection exists.
14. All rejected/duplicates -> no coalesce call with an empty array.
15. Result chunks hit exact count/sealed-wire/server boundaries, split at +1,
    preserve order, and never exceed one chunk of retained ids for a large
    suffix/duplicate stream.
16. ACK/rejection chunk publish failure leaves outcome state replayable; later
    chunks still attempt delivery and no id crosses outcome classes.
17. Cancelled fallback tombstones across many accounts stay within shared
    256-entry/256-KiB caps and evict oldest without cross-account key collision.
18. Failed cancel record + lost ACK + full raw budget recovers through one
    bounded resolver task as accepted/ACK only, overrides a conflicting hot
    overload, never dispatches/rejects, and deletes fallback only on success.
19. Opposite-marker delete disk failure returns unknown, keeps fallback/overload,
    releases the operation gate, and emits no ACK.
20. Accepted and overloaded receipt rollback-delete failure quarantine the exact
    marker; same-process hot/cold replay emits no result/dispatch while cleanup
    fails, later cleanup permits fresh classification, and the 2,048-entry/2-MiB
    recovery cap poisons fail-closed without eviction or metadata growth.
21. Non-string/oversized ids are never persisted or echoed in a result payload.
22. Mixed batches with a classified prefix followed by lookup-unknown,
    accepted-record-unknown, or overload-record-unknown commit/publish the prefix,
    treat the unresolved current entry as a FIFO barrier, and perform no lookup,
    record, offer, result, or dispatch for its suffix; all released ledger ids can
    retry later without accounting leaks.
23. A multi-item batch invalidated by `/stop` releases all held outcome gates
    before awaiting cancellation handlers, so replacement writes cannot
    self-deadlock and no normal result/dispatch escapes after invalidation.

### 7.3 Client tests

1. `sent -> inbound_rejected -> failed(overloaded,retryable:true)` and ledger
   removal.
2. Rejection before/after a stray ACK cannot move a failed receipt backward.
3. Duplicate rejection notifies once; unknown id is a no-op.
4. Wrapper bubble and `SendReceipt` survive/render the failure; retracted/missing
   bubble receipt still resolves.
5. Rejection does not change typing, current draft, held queue, approvals, or
   history.
6. Rejected id is not replayed on reconnect; a new explicit retry gets a new id.
7. Multi-device broadcast of another device's rejected id is harmless.
8. A live unacked send retries the same id at injected 1/2/4/8/30-second capped
   backoff without duplicate `sent` transitions; ACK and rejection cancel it.
9. Agent-only outbound disconnect/reconnect with a continuously connected
   browser eventually receives the replayed terminal result.
10. Close, terminal failure, ledger eviction, and session reset cancel/re-arm the
    single timer without leaks; 100 entries remain the hard memory bound.
11. A two-or-more-id ACK or rejection frame detaches the whole frame before the
    first state callback; callback-driven disconnect/reconnect preserves every
    later id's authoritative accepted/failed(overloaded) state and leaves no
    ledger/timer residue.

### 7.4 Protocol and integration tests

1. v2 client request <-> v2 plugin reply succeeds.
2. absent/v1/malformed request version is rejected before peer registration/key
   establishment.
3. v2 client treats absent/v1/malformed reply as terminal protocol mismatch.
4. cross-package lockstep test pins both constants to 2.
5. stalled dedupe plus never-settling handler and exact combined count/byte
   boundaries prove neither debouncer chains nor pending usage exceed limits;
   normal bounded coalescing still yields one follow-up.
6. two accounts share the process cap without mixing routes/messages.
7. authenticated unregister and oldest-peer cap eviction invalidate overflow
   work and release only that peer's debounce+pending accounting.
8. coordinator abort/finally disposes both retention layers once, gracefully
   closes/removes only the exact runtime, and releases reservations owned by that
   account; start -> stop -> start builds a fresh transport and register
   subscription, leaves the old generation inert, and a transient NATS reconnect
   preserves admitted work.
9. advertised `INFO.max_payload` below/above the local limit is honored; boundary
   result publishes, and oversized direct payload throws before a `PUB` header/
   write while the connection remains usable.
10. pressure logger rate limit/aggregation has no message text or ids.
11. Concurrent starts for one account remain coordinator-single-owner; abort and
    retry serialize behind exact-generation cleanup, late old cleanup cannot touch
    a fresh replacement, and a stale generation never subscribes or enters the
    runtime map.

### 7.5 Verification commands

After dependencies are installed:

```bash
npm run typecheck
npx vitest run \
  packages/plugin/src/inbound-retention.test.ts \
  packages/plugin/src/bounded-inbound-debouncer.test.ts \
  packages/plugin/src/inbound-overflow-resolver.test.ts \
  packages/plugin/src/inbound-queue.test.ts \
  packages/plugin/src/ingress-outcome.test.ts \
  packages/plugin/src/ingress-result-chunks.test.ts \
  packages/plugin/src/ingress-dedupe.test.ts \
  packages/plugin/src/nats-channel-ack.test.ts \
  packages/plugin/src/nats-transport.test.ts \
  packages/plugin/src/nats-register.test.ts \
  packages/plugin/src/channel.test.ts \
  packages/plugin/src/nats-account-runtime.test.ts \
  packages/plugin/src/index-nats-wiring.test.ts \
  packages/client/src/nats-client-sendstate.test.ts \
  packages/client/src/nats-client-wrapper-sendstate.test.ts \
  packages/client/src/nats-client-register.test.ts \
  e2e/protocol-version-lockstep.test.ts
npm test
npm run build
```

Also run the pack/load smoke tests required by `docs/PACKAGING.md` because both
published package wire surfaces and plugin bundle wiring change.

## 8. Implementation sequence

1. Add shared reservation budget, bounded debouncer, overflow resolver, and
   exhaustive stalled-flush/dispatcher tests.
2. Add the tri-state/durability-aware outcome store and bounded result chunker
   with crash/storage-fault tests.
3. Add `inbound_rejected` wire type/sender and protocol-v2 register enforcement.
4. Refactor ingress ordering around retained token -> lookup/offer -> outcome
   record -> commit/release -> result.
5. Wire the single shared process budget, peer/account lifecycle cleanup, outbound
   size guard, and rate-limited pressure logger.
6. Add client tracker failure handling and same-id live pre-outcome retry.
7. Add integration/protocol/source-guard tests, then update changelogs and docs.
8. Run typecheck/tests/build and the package/load smoke suite.

Commits should keep protocol/server/client changes together or leave tests
deliberately red between commits; no intermediate published state may ACK an
overflow without a client-understood terminal result.

## 9. Rollout and compatibility

- This is a breaking lockstep wire release: new client and plugin deploy together.
- Existing accepted pending work is not migrated; process restart starts with an
  empty in-memory buffer as today.
- Defaults are fixed constants. Pressure logs are the signal for a later,
  separately reviewed configuration surface.
- A sustained overload causes visible retryable failures, not heap growth or
  cross-session eviction.
- Rollback requires rolling back client and plugin together because v2 register
  rejects v1 peers in both directions.

## 10. Review convergence record

This section is updated after each read-only adversarial sub-agent round.

| Round | Reviewer | Verdict | Material changes |
|---|---|---|---|
| R1 | Codex (`gpt-5.6-sol`, xhigh) | NEEDS_CHANGES — 3×P1, 2×P2 | Removed contradictory accepted+overloaded recording; added tri-state outcome storage, same-id consistency, bounded result chunks/outbound guard, peer/account teardown wiring, terminal disposed latch, and live same-id pre-outcome retry. |
| R2 | Codex (`gpt-5.6-sol`, xhigh) | NEEDS_CHANGES — 1×P1, 1×P2 | Replaced the uncapped SDK debouncer with a reservation-owning bounded implementation covering waiting/in-flight chains; added a bounded overflow resolver and required durable overload persistence before terminal rejection. |
| R3 | Codex (`gpt-5.6-sol`, xhigh) | NEEDS_CHANGES — 1×P2 | Replaced per-account outcome hot caches/stores with process-wide count+byte-bounded caches and dedupe instances; accountId remains a logical namespace only. |
| R4 | Codex (`gpt-5.6-sol`, xhigh) | PASS — no actionable P0-P2 findings | Full v4 re-read confirmed closure of all prior findings; no further plan changes required. |
