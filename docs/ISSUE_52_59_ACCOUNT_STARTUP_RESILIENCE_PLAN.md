# Issues #52 + #59 — Account startup isolation and recovery plan

> Status: **APPROVED FOR IMPLEMENTATION — rev8, adversarially converged in round 8**
> Scope: [`#52`](https://github.com/mir-stream/openclaw-webchannel/issues/52),
> [`#59`](https://github.com/mir-stream/openclaw-webchannel/issues/59)
> Target: `packages/plugin` (OpenClaw compatibility floor and build pin: `2026.6.10`)

## 1. Why these two issues belong in one change

The current NATS entry starts every configured account in one asynchronous
`registerFull` batch. A process-wide `accountsBuildStarted` latch is set before
that batch does account-specific work.

That creates two versions of the same ownership bug:

1. A malformed account ID can throw before the per-account `try/catch`, aborting
   healthy accounts too (#52).
2. A valid account whose first NATS connection fails is skipped, but no owner is
   left behind to retry it (#59). Later `registerFull` calls see the latch and do
   nothing.

The latch is therefore not merely in the wrong place. It is standing in for a
lifecycle that OpenClaw already provides: `gateway.startAccount` is started,
tracked, aborted, and stopped separately for each account. The durable fix is to
put each account's NATS startup loop under that lifecycle and remove the global
one-shot batch.

Current failure flow:

```text
registerFull
  -> set global latch
  -> account A succeeds
  -> account B throws or cannot connect
  -> remaining batch is skipped or B is forgotten
  -> later registerFull call is suppressed by the latch
```

Target flow:

```text
OpenClaw account task A -> preflight -> connect -> atomically publish runtime
OpenClaw account task B -> preflight -> transient failure -> backoff -> retry
OpenClaw account task C -> permanent failure -> actionable terminal state
OpenClaw abort           -> cancel timer/dial -> remove owned runtime -> disconnect
```

One account's state never controls another account's task.

## 2. Product decisions already made

These are fixed inputs to implementation and review, not open questions.

### 2.1 Retry horizon

- Retry **indefinitely only for typed transient initial-connection failures**.
- The first dial is immediate.
- After each transient failure, use exponential **full jitter**:
  `delay = random(0, min(60_000, 1_000 * 2^(failedAttempts - 1)))` ms.
- `1s` and `60s` are the nominal first and maximum delay ceilings; a full-jitter
  draw may be zero.
- Permanent and unknown failures do not retry. They remain fail-closed until an
  OpenClaw configuration reload or process restart creates a new account task.
- No new operator-facing retry settings or environment variables are added.

### 2.2 Observability scope

For these issues, “logs and metrics” means:

- structured, rate-limited lifecycle logs; and
- OpenClaw's per-account `ChannelAccountSnapshot` status fields.

Prometheus/OpenTelemetry exporters and a new time-series subsystem are out of
scope. They can consume these state transitions in a separate change later.

### 2.3 Invalid IDs

- Never silently canonicalize an already-stored account key. The account ID is
  part of credential paths, NATS subjects, and JWT audience; rewriting it would
  select a different security identity.
- Reject only the invalid account, log an actionable error, and emit an
  `openclaw doctor` finding.
- Continue starting every valid account.
- If an explicit accounts map contains only invalid keys, return no serving
  account IDs. Do not synthesize a phantom `default` account. The existing
  implicit `default` fallback remains for absent/empty/flat account config.

## 3. Verified host and transport constraints

Implementation must preserve these constraints, verified against the exact
`openclaw@2026.6.10` package rather than assuming current upstream behavior.

1. `defineChannelPluginEntry` invokes `registerFull(api)` without awaiting a
   returned promise. A rejected async `registerFull` can therefore escape as an
   unhandled rejection.
2. The same wrapper calls `registerFull` in both `tool-discovery` and `full`
   registration modes. Only `full` is a live runtime dependency source;
   tool-discovery must not install or replace account-lifecycle state.
3. OpenClaw starts one `gateway.startAccount(ctx)` task per listed account,
   reserves that account before the first `await`, supplies an `AbortSignal` and
   status setters, and owns stop/reload orchestration.
4. If `startAccount` throws, core's generic restart policy is finite (ten
   attempts on the pinned version). The selected indefinite transient policy
   therefore has to stay inside one live account task instead of repeatedly
   throwing to core.
5. `startAccount` already hosts `startClawApprovalMonitor`; NATS startup must be
   composed with it without leaving either task alive after its sibling fails or
   the host aborts.
6. `NatsTransport` retries only after an established connection. Its initial
   `connect()` rejection is intentionally caller-owned. Existing
   post-establishment reconnect and subscription replay remain in place.
7. The connector currently loses access to a newly created transport until
   `await transport.connect()` succeeds. That prevents reliable cancellation of
   an in-flight initial dial and must be repaired as part of this change.
8. Core waits at most five seconds after abort for an account task to stop. The
   plugin's timer/dial/runtime cleanup must normally settle inside that bound.

## 4. Scope and non-goals

### In scope

- Account-ID inspection and isolation.
- A synchronous, idempotent `registerFull` dependency/config handoff.
- Per-account startup ownership under `gateway.startAccount`.
- Typed initial-connect failure classification.
- Infinite capped full-jitter retry for transient failures.
- Abort-safe timer, dial, partial-build, and published-runtime teardown.
- Exactly-once account wiring and deterministic primary-channel binding.
- Doctor, account status, transition logs, and focused tests.

### Out of scope

- Watching credential files or config files from the plugin. OpenClaw reload is
  the reconfiguration boundary.
- Retrying permanent configuration, missing-credential, invalid-key, or explicit
  authentication failures.
- Changing authentication, encryption, admission, or JWT trust semantics.
- Changing the established-connection reconnect policy beyond any mechanical
  typed-error plumbing required by the initial-connect boundary.
- Prometheus/OpenTelemetry export.
- Automatic account-ID repair or config mutation.

## 5. Proposed architecture

### 5.1 Make full-runtime registration synchronous and mode-aware

`index-nats.ts` will retain `registerFull`, but it will no longer connect to
NATS or build account runtimes. It will ignore non-full registration and
synchronously make the full API available to future account tasks.

```ts
registerFull(api) {
  if (api.registrationMode !== "full") return;
  accountCoordinator.installFull(api); // no await, no network I/O
}
```

Installation performs no account inspection or resource creation. Account
preflight remains in `startAccount`; authoritative raw-ID inspection happens in
the config adapter when OpenClaw supplies its runtime `cfg` (§5.2).

Full installation snapshots only the durable host dependencies the extracted
builder actually uses (`api.runtime` and `api.logger`). It does **not** retain
`api.config` as account configuration or a generation key. The pinned host
derives full-registration config and account-task config through separate merge
paths, so equal content does not imply reference identity.

`ctx.cfg` is the authoritative configuration for every account read. Refactor
builder/helper parameter types to the minimal `{ runtime, logger, config }`
surface and create that account execution view from the durable full snapshot
plus `config: ctx.cfg`; no helper may accidentally read the full API's config.

Generation identity is a monotone full-install token deduplicated structurally,
not an account config object lookup:

- at full installation only, deterministically canonicalize the JSON-like
  `api.config` (sorted object keys, preserved array order and primitive values)
  and hash it with SHA-256;
- keep only the latest full-install fingerprint/generation record: a consecutive
  full registration with the same fingerprint refreshes durable dependencies but
  keeps the generation; a different fingerprint creates a newer monotone record;
- do not globally reuse historical records by digest: a deliberate `A -> B -> A`
  config rollback must produce generations 1, 2, and 3, not resurrect generation
  1 as a stale task;
- never log the canonical form or digest input because config may contain
  secrets; the digest itself is diagnostics-only and need not be logged;
- cyclic/non-JSON config is a typed host-integration invariant failure;
- full re-registration merely refreshes durable dependencies for **future**
  starts and never changes an existing generation/owner by itself;
- a tool-discovery API never refreshes durable dependencies.

An account task captures the latest full-install token/durable snapshot and its
own authoritative `ctx.cfg` before building; it never looks `ctx.cfg` up by
identity or compares it to `api.config`. Equal config content with different
object references is a required test case. A task with no prior full snapshot is
a typed host-integration invariant failure.

Remove `accountsBuildStarted`. Repeated `registerFull` calls cannot start a
second dial loop because registration no longer starts any loop.

### 5.2 Inspect account IDs once, without rewriting them

Add a structured helper in `account-config.ts`:

```ts
type AccountIdInspection = {
  validIds: string[];              // sorted
  invalid: Array<{ id: string; reason: string }>;
  usesImplicitDefault: boolean;
};

inspectWebchannelAccountIds(cfg): AccountIdInspection
```

Consumers:

- `listWebchannelAccountIds` returns `validIds`.
- `planAccounts` plans only `validIds`.
- the full NATS entry injects an optional `onInvalidAccountId(cfg, invalid)`
  callback into `createWebChannelPlugin`. Its `config.listAccountIds(cfg)`
  wrapper computes and retains `validIds` first, then invokes the callback in an
  independent `try/catch` for each invalid entry, and returns `validIds`
  regardless of reporting failures;
- the callback reports once per full-install generation when a full snapshot and
  logger exist. Before full install (including discovery mode) it is a strict
  no-op. A throwing logger/reporter is swallowed after best-effort console-safe
  fallback and can never affect enumeration. The setup/read-only entry omits it.
- doctor emits an `invalid-account-id` finding from `invalid` and never passes
  that ID to a credential-path function.

The `assertValidAccountId` checks at filesystem boundaries remain as defense in
depth. `canonicalizeAccountId` remains limited to config-writing/setup paths.

### 5.3 Introduce a per-account runtime coordinator

Extract the side-effectful account build from the plugin entry into a directly
testable module, tentatively `src/nats-account-runtime.ts`.

The coordinator owns:

```ts
type AccountLifecycleState =
  | "starting"
  | "retry-scheduled"
  | "serving"
  | "quarantined"
  | "permanent-failure"
  | "stopped";

type RuntimeOwner = {
  generation: GenerationRecord;
  accountId: string;
  hostSignal: AbortSignal;
  workController: AbortController;
  released: Promise<void>;
};

type LifecycleWaiter = {
  generation: GenerationRecord;
  arrival: number; // per-account monotone token
  hostSignal: AbortSignal;
  grant: Deferred<RuntimeOwner>;
};

type AccountQuarantine = {
  closeHandle: PhysicalCloseHandle;
  probeCutoffArrival: number;
  probe?: { waiter: LifecycleWaiter; released: Promise<void> };
};
```

It also owns the existing `accountRuntimes` map and primary binding. An account
task links an owner-local work controller to its host/child signal and reserves its
`(generation, accountId)` owner synchronously before its first `await`. The exact
OpenClaw host already deduplicates account boots; this local owner check is
defense in depth and makes unit tests independent of host internals.

Overlap policy is explicit:

- every invocation receives a per-account monotone arrival token; every
  overlapping invocation registers one abortable waiter and performs no
  dial while an owner lease exists; it must not return early and look like a
  crashed/exited channel;
- a newer generation never internally aborts a live owner. The owner retains its
  slot through synchronous unpublication and complete async disposal, even after
  its host signal aborts;
- after owner release, the coordinator synchronously promotes exactly one
  eligible waiter only when the old transport is confirmed physically closed:
  the highest generation, with FIFO tie-break for same-generation replacement.
  Waiters whose own host signal aborted are removed before selection;
- a per-account highest-seen generation watermark prevents an older stale waiter
  from becoming owner after any newer generation has been observed, even if all
  newer waiters later abort. It remains dormant until its own host abort;
- a same-generation waiter may acquire after the prior owner has aborted and
  fully released. This supports a legitimate host replacement without running
  two loops at once.

Host abort cleanup order is load-bearing:

1. synchronously mark the owner closing;
2. if its runtime is published, remove it by owner+runtime identity, recompute
   primary, and write stopped status immediately; each reporting/rebind failure
   is captured and cannot short-circuit resource cleanup;
3. abort timer/dial/private work and await the idempotent full disposer inside a
   `try`, retaining its physical-close report; then, **unconditionally in
   `finally`**:
4. remove the owner slot only if it still matches and resolve `released` through
   an exactly-once guard; and
5. synchronously promote one selected waiter only if physical closure was
   confirmed. Otherwise install the account quarantine described in §5.7 and
   leave every waiter dormant without dialing.

No waiter can acquire before the `finally` release. Therefore old cleanup always gets a
chance to unpublish its own runtime and can never delete a later runtime.

Lease release and quarantine installation occur even when disposal or reporting
fails. Thus a cleanup fault cannot orphan the owner slot, while failure to prove
socket closure also cannot create a second live authenticated connection.

Waiter promotion invokes no plugin/user callback: it is a synchronous manager
state transition that installs the selected waiter as owner and resolves its
deferred grant. If that internal transition unexpectedly throws, it rolls back
any matching partial owner, rejects that waiter's grant with a typed invariant,
and continues with the next eligible waiter; it never leaves an owner without a
running task or an unresolved old `released` promise.

Thus config generation does not manufacture an unexpected early lifecycle exit.
The host remains the authority that aborts composed account tasks; local
generation logic only serializes or fences them.

Only the owning task may install or remove its runtime. All commits, listener
status writes, and deletes compare owner plus runtime identity. A stale task can
therefore neither publish after reload, overwrite status, nor delete a newer
task's runtime.

### 5.4 Compose NATS startup with the approval monitor

Extend `createWebChannelPlugin` with an injected NATS account lifecycle:

```ts
createWebChannelPlugin(lazyTransport, {
  resolveApprovalTransport,
  startNatsAccount,
});
```

`gateway.startAccount` runs `startClawApprovalMonitor` and `startNatsAccount`
under a child `AbortController` linked to `ctx.abortSignal`.

Composition rules:

1. Normal operation keeps both promises alive until host abort.
2. If either promise unexpectedly rejects or resolves before host abort, abort
   the child signal, await **both** promises with `Promise.allSettled`, then
   propagate the unexpected error to core.
3. On host abort, abort the child, await both cleanups, and resolve normally.
4. A permanent NATS startup failure is handled inside the NATS lifecycle: set
   terminal status and wait for abort. It does not throw into core's generic
   finite restart loop, and it does not create an approval transport.

This prevents a rejected `Promise.all` from abandoning the approval monitor or
an NATS dial in the background.

### 5.5 Separate preflight, dial, wiring, and commit

Each valid account follows four explicit phases:

#### Phase A — synchronous/permanent preflight

- Re-resolve the named account from the task's captured authoritative `ctx.cfg`
  execution view.
- Validate account ID before any path access.
- Resolve encryption policy.
- Resolve effective auth and validate the JWT verifier configuration.
- Resolve credential source and statically validate URL/NKEY material.
- Load enrolled credentials and identity key when that mode requires them.
- Evaluate the existing shared `(issuer, audience)` diagnostic.

Every actual preflight failure here becomes `permanent-failure`, with no network
attempt. Shared `(issuer, audience)` is deliberately **not** a skip in this
change: current behavior logs a loud warning while doctor reports an error, then
continues serving. Preserve that behavior and emit each normalized collision
pair at most once per config generation. Turning it into a single-winner policy
would change auth/admission semantics and requires a separate product decision.
Invalid or otherwise unresolvable IDs never participate in the diagnostic.

Diagnostic preparation may inspect all configured accounts, but every entry is
wrapped independently and its result never controls another account's serving
state. One bad account cannot abort preparation or another account's task.

#### Phase B — abortable initial dial loop

- Dial immediately.
- On typed transient failure, record status, log according to section 8, wait
  for abortable full-jitter backoff, and retry.
- On typed permanent/unknown failure, await disposal of any attempt resources,
  set terminal status, and wait for host abort.
- On abort, cancel the timer or in-flight dial and exit without another attempt.
- If the transport completed its first handshake but drops before commit, dispose
  it and begin a fresh attempt using the typed disconnect cause. Do not publish a
  disconnected runtime or wait on that private transport's reconnect loop.

Each successful initial handshake installs a sticky private-attempt connection
epoch before any awaited Phase C work. Its disconnect listener:

1. records the first typed disconnect cause and permanently marks that attempt
   `preCommitPoisoned`;
2. calls `transport.disconnect()` immediately to set `closed`, cancel/suppress
   any auto-reconnect timer, and close a reconnect that raced; and
3. does not write serving status because the runtime is still private.

The poison bit never resets, even if a forced/fake late reconnect sets
`connected` true again.

There is exactly one active timer or dial per owner, never both concurrently.

#### Phase C — complete account wiring off-map

After a successful transport handshake, build the full serving runtime while it
is still private to the attempt:

- construct encryption/key/channel objects;
- install inbound, control, history, command, approval, and register handlers;
- run the existing JWKS readiness preflight with the owner child signal (a JWKS
  source error keeps its current fail-closed-but-serving behavior, but lifecycle
  abort immediately leaves the phase); and
- attach existing established-connection listeners/reconnect behavior.

Any failure awaits the private runtime's full disposer. Nothing is visible through
`accountRuntimes`, the approval resolver, the lazy primary facade, **or a NATS
subscription** yet. The register handler may be installed, but the register
subject is not subscribed during any awaited work.

Every Phase-C await is lifecycle-abortable. The builder inventories these awaits
explicitly; currently the only external wait is `preflightResolveJwks`. It gains
an `AbortSignal` that is threaded through `JWKSCache.warm` to URL fetch, response-
body read, and file read. Inline JWKS checks the signal before returning. The
child signal is composed with the existing startup-warm deadline rather than
replacing that deadline, and every temporary abort listener/controller/timer is
removed on settle.

The cache's existing shared `inflightRefetch` cannot make one aborted account
wait for another consumer or let one consumer's abort unnecessarily cancel the
others. Refactor it into an operation record with an internal controller and
abortable subscriber promises:

- each caller registers a subscriber and settles immediately with a typed
  lifecycle abort when its own signal aborts;
- the underlying source operation continues while at least one non-aborted
  subscriber remains;
- when the final subscriber leaves, abort the internal source controller and
  clear/fence the operation record. URL fetch and body consumption receive that
  signal; the default file loader calls abortable `fs.readFile`, and injected
  loaders receive the signal too;
- each low-level external promise is also raced through a listener-cleaned
  abort wrapper. Thus a non-cooperative injected fetch/body/file promise cannot
  keep the cache operation record or account task pending after abort; and
- cache writes and `inflightRefetch` clearing compare operation identity and
  re-check abort state, so a late result from an abandoned source cannot poison
  the cache or clear a newer operation.

The startup-warm 10-second source deadline becomes a bound for URL headers/body
*and* file/injected reads and remains the maximum for a live task; host/child
abort is the earlier bound. Preserve abort reasons: an independent source
deadline remains `JwksUnavailableError` and keeps the existing fail-closed-but-
serving readiness behavior, while an observed child abort wins a same-turn race
and normalizes to the lifecycle `aborted` kind. A lifecycle abort is
discriminated before the readiness diagnostic: emit no `JWKS FETCH FAILED`/ready
log or stale status, skip all later Phase-C work, and immediately await the
attempt disposer. Owner/connection/poison fences still prevent a late warm
result from reaching Phase D, `subscribeRegister`, map publication, or serving
status.

#### Phase D — atomic commit

Immediately before publication, verify:

- neither host nor child signal is aborted;
- this task still owns the account slot; and
- `transport.connected === true` after all awaited private preparation; and
- the sticky `preCommitPoisoned`/connection-epoch fence is still clear.

Then execute one no-`await` synchronous commit section:

1. re-check all fences;
2. call `subscribeRegister()`;
3. install the fully wired `AccountRuntime` in the map;
4. recompute the primary binding; and
5. update status to `serving` last.

Because the SUB write and publication occur in one JavaScript turn, no inbound
register event can interleave between them. If subscription throws, publish
nothing and dispose the private runtime. If any later synchronous commit step
unexpectedly throws, synchronously fence and remove only the just-installed
runtime, recompute primary, write a non-serving status rollback, then **await**
its disposer before propagating the typed invariant failure. Internal map
publication and primary computation occur before the final serving-status write;
the pinned status sink is synchronous/non-throwing, but a throwing test seam must
still take the same full rollback path. No task may terminate while its rollback
disposer is running in the background. If connection state became false, map the
recorded typed disconnect cause (defaulting to transient early disconnect),
dispose, and return to Phase B.

On later abort, delete only if `accountRuntimes.get(accountId) === ownedRuntime`,
synchronously delete/fence it, recompute primary, and write stopped status
**before** awaiting its disposer. This makes approval/outbound resolvers stop
selecting the closing runtime immediately while still keeping the account task
alive until cleanup finishes.

### 5.6 Deterministic primary binding

The current primary is selected once after a sequential batch. Concurrent
recovery makes that timing-dependent unless binding becomes dynamic.

After every runtime install/remove:

1. prefer the serving `default` runtime;
2. otherwise choose the serving account with lexicographically smallest ID;
3. otherwise bind `null`.

Thus a late-recovering `default` correctly supersedes a temporary fallback, and
teardown cannot leave the lazy facade pointing at a disconnected transport.
The unpublish helper first clears `boundChannel` when it points at the removed
runtime, then computes the replacement. Therefore even an injected replacement-
selection failure leaves a safe `null`, never the closing channel; the error is
reported without blocking disposal/release.

Account-targeted approvals continue resolving directly from
`accountRuntimes`; they do not depend on the primary.

### 5.7 Give every runtime a complete disposer

`AccountRuntime` and the private build result gain an idempotent async
`dispose()` backed by one shared promise; concurrent/repeated callers observe the
same completion report. Transport disconnect alone is not lifecycle cleanup.

```ts
type DisposeReport = {
  errors: Array<{ phase: string; error: unknown }>;
  transport: TransportCloseReport;
};

type TransportCloseReport = {
  reconnectSuppressed: boolean;
  socketClosed: boolean;
  forcedTerminationAttempted: boolean;
  gracefulTimedOut: boolean;
};

dispose(): Promise<DisposeReport>; // resolves; cleanup faults are data, not rejection
```

For retry, rollback, or waiter promotion,
`transportClosed` means exactly
`report.transport.reconnectSuppressed && report.transport.socketClosed`. A
logical `closed` flag, an empty `this.ws` reference, or a successful return from
`ws.close()`/`ws.terminate()` is not physical-closure evidence by itself.

The builder tracks every peer/session key observed by the account. Disposal is
ordered:

1. atomically set a `disposed` gate so message handlers, debounce `onFlush`,
   fire-and-forget cancellation work, and dispatcher drains cannot begin a new
   turn or publish an ACK;
2. call `inboundDebouncer.cancelKey` for all observed keys and
   close the serialized dispatcher, clearing its busy-time coalesce buffers;
3. detach account lifecycle `disconnect`/`reconnect`/`error` listeners;
4. dispose the `NatsChannel` message listener and subscriptions/handler
   references; and
5. in a disposer-level `finally`, run and await the bounded transport shutdown
   protocol below.

Each phase has its own `try/catch`; a failure is appended to the sanitized
`DisposeReport` and all later phases still run. The disposer itself resolves a
report rather than rejecting, but owner release still uses `finally` as defense
in depth.

`NatsTransport` gains an idempotent logical shutdown plus a bounded,
confirmation-based physical shutdown:

1. synchronously set the logical closed gate, clear reconnect timers, reject new
   publish/subscribe/connect work, and capture the owned WebSocket before
   clearing any current/public reference;
2. retain that captured handle until closure is confirmed; do not make it
   unreachable merely to report the transport as closed. If no socket was ever
   created, `socketClosed` is true after reconnect suppression because there is
   no physical resource to close;
3. attach a close-confirmation listener, then request graceful close only for a
   socket state where it is meaningful. A `CONNECTING` socket, a throwing close,
   or a graceful-close timeout escalates to public `WebSocket.terminate()` (or
   an equivalently testable underlying-socket destroy seam);
4. wait a second bounded interval after forced termination. Set `socketClosed`
   only after the captured socket emits `close` or has observable
   `readyState === WebSocket.CLOSED`; neither invoking termination nor the
   transport's logical flag is sufficient; and
5. remove temporary confirmation listeners/timers and resolve the report on
   every path. No graceful or forced close is awaited indefinitely.

Use internal defaults of at most 250 ms for graceful confirmation and 250 ms
after forced termination, with injected clocks/deadlines in unit tests. This
keeps ordinary plugin cleanup comfortably inside the pinned host's five-second
stop bound. `disconnect()` remains the synchronous no-throw reconnect-
suppression entry point for legacy callers and starts the same shared shutdown;
the account disposer uses the awaitable close method to obtain the report.
Concurrent close callers share the in-flight attempt.

The ready-state table is deterministic: no captured socket or `CLOSED` is
already confirmed; `CONNECTING` escalates immediately; `OPEN` gets one graceful
request and grace interval; and `CLOSING` gets the grace interval without a
second close request before escalation. State and close-event checks occur after
the listener is attached and again at each boundary, so a close racing setup is
not missed.

If the first bounded attempt cannot prove socket closure, the transport retains
the captured socket in a coordinator-owned physical-close handle. A later
explicit cleanup probe may make another bounded terminate/confirm attempt; it
does not re-enable reconnect, create a WebSocket, or dial NATS.

Extend `NatsChannel` with an idempotent disposal seam (or an equivalently exact
listener/subscription cleanup owned by the builder); do not use garbage
collection as cleanup. A turn already running at abort may settle according to
OpenClaw's own turn lifecycle, but no debounce buffer or queued follow-up may
start after disposal and all late channel sends fail closed.

The gate must cross async boundaries, not merely guard entry:

- extend `createIngressOnFlush` with an injected `isActive()` and re-check after
  every awaited dedupe operation, immediately before ACK, and immediately before
  dispatch;
- apply the same post-await/pre-ACK checks to `recordCancelledInboundItems`;
- extend `SerializedInboundDispatcher` with idempotent `close()` semantics that
  reject new dispatch, clear all pending buffers, and make already-registered
  settle callbacks skip recursive follow-up dispatch; and
- treat an inactive result as an intentional drop, not an `onError` outage.

Tests pause an already-running dedupe promise, dispose the runtime, then resolve
the promise and prove no late ACK, turn, or follow-up occurs.

Cleanup error policy:

- intentional host abort logs a sanitized aggregate report and finishes release,
  but it follows the same physical-close gate as every other path;
- retry, commit rollback, or waiter promotion may continue only when
  `transportClosed === true` and disposed gates are installed;
- if physical closure is unproven, synchronously keep the runtime unpublished,
  release its owner lease exactly once, retain the close handle, and put the
  account in a terminal fail-closed quarantine. No existing waiter, retry loop,
  or abort path may dial while the quarantine exists;
- if that owner invocation's host signal is still live, demote it back into the
  ordinary waiter set with its original generation/arrival token and a fresh
  grant before releasing the owner slot. If its host is already aborted, do not
  requeue it. This is how “every task remains represented” also covers the task
  that owned the failed private or serving runtime;
- every task remains represented by its ordinary waiter while quarantine
  exists. The task that caused quarantine and all pre-quarantine waiters stay
  pending—not resolved or rejected—until either their own host aborts or a later
  successful probe clears quarantine and selects one for normal promotion. Thus
  quarantine cannot manufacture core restart attempts or terminate the composed
  approval monitor;
- at quarantine creation, set `probeCutoffArrival` to the greatest arrival token
  observed. The first non-aborted waiter arriving with a strictly greater token
  atomically takes the single probe lease while remaining in the ordinary waiter
  set. It performs exactly one bounded physical-close attempt against the
  retained handle—no credential read, WebSocket creation, or NATS dial;
- concurrent arrivals during a probe remain ordinary pending waiters and cannot
  start another probe. If closure is still unconfirmed, release the probe lease
  exactly once, advance `probeCutoffArrival` to the greatest arrival observed at
  completion, and leave the probe task plus all other waiters pending until
  their own host abort. Only a strictly later arrival can run the next single
  probe; there is no automatic repeat or core-restart loop;
- on confirmed close, release the probe lease once, atomically clear quarantine,
  and run normal promotion over **all** ordinary non-aborted/non-stale waiters,
  whether they arrived before quarantine, during it, or as the probe. Select
  highest generation then FIFO. The probe waiter can therefore promote itself
  when it wins; every unselected waiter remains pending under the usual overlap
  rules;
- arrival sequence, not config-generation equality, defines “later”, so an
  OpenClaw reload with unchanged config can safely trigger one cleanup probe.
  If the selected probe's host aborts during its already-bounded close attempt,
  finish that attempt and release the probe lease once; a confirmed result may
  clear quarantine and promote another live eligible waiter, while an
  unconfirmed result advances the cutoff and permits no dial;
- the current owner/waiter writes supported `connected: false`,
  `restartPending: false`, and a sanitized terminal `lastError` while
  quarantined. Owner/runtime/arrival fences suppress stale status writes. The
  coordinator retains no published runtime, primary binding, subscriptions, or
  inbound work while it retains the private close handle;
- stopped/rollback status and primary-rebind errors are diagnostics only after
  synchronous map fencing; they never prevent disposal or release.

## 6. Abortable resource ownership

### 6.1 Initial connect contract

Extend the connection seam so the caller owns a transport before or while its
handshake is pending. The preferred API is to thread `AbortSignal` through
`consumeCredentialSource` -> `connectNatsCredentialSource` ->
`NatsTransport.connect`.

Required behavior:

- an already-aborted signal performs no dial and rejects with a typed abort;
- abort during DNS/WebSocket/NATS handshake closes the socket and settles the
  connect promise promptly; the attempt disposer awaits the bounded confirmation
  protocol, and an unconfirmed physical close enters account quarantine instead
  of permitting a retry;
- handshake-only abort, phase-timeout, and `unexpected-response` listeners/timers
  are removed on every connect settle path;
- abort is never classified as a retryable failure or logged as an outage;
- a success racing with abort is treated as abort and disconnected;
- `disconnect()` remains idempotent and suppresses post-close reconnect.

Promptly means the normal path settles well inside OpenClaw's pinned five-second
account-stop timeout; tests use a much tighter deterministic bound.

Operational socket `message`/`error`/`close` listeners survive a successful
handshake because normal delivery and reconnect require them. They are removed
when that socket closes or `disconnect()` owns teardown. An unexpected HTTP
upgrade response is drained or destroyed and its underlying socket is destroyed
before rejection; it must not remain as an unowned readable/socket handle.

If implementation retains the current connector return shape, it must use a
factory callback or attempt handle to expose the transport before awaiting it;
`Promise.race` alone is insufficient because it would leave the losing dial
alive.

### 6.2 Attempt cleanup invariant

Every dial/build attempt is shaped as an ownership transaction:

```text
create resource -> attempt owns it
build succeeds   -> coordinator atomically takes ownership
anything else    -> attempt awaits its full disposer in finally
```

The implementation must not rely on garbage collection to close a WebSocket or
remove a NATS subscription.

## 7. Typed failure model

High-level lifecycle code must branch on a discriminated type, never on human
log text.

```ts
type AccountStartupFailure = {
  kind: "transient" | "permanent" | "aborted" | "unknown";
  code: AccountStartupFailureCode;
  phase: "preflight" | "dns" | "websocket" | "tls" | "nats-auth" | "nats-protocol" | "wiring";
  cause: unknown;
  operatorMessage: string; // sanitized; no JWT, seed, or credential path contents
};
```

Classify errors at the lowest boundary that still has structured information:

| Class | Examples | Policy |
|---|---|---|
| aborted | host/config-reload abort | clean stop, no retry/error log |
| transient | `EAI_AGAIN`, `ENOTFOUND`, refused/reset/unreachable sockets, typed transient WebSocket close, handshake timeout, HTTP upgrade 408/425/429/5xx, NATS authentication timeout | retry forever with capped jitter |
| permanent | invalid account/config/URL, missing or malformed credentials, invalid NKEY seed, missing attested identity key, encryption/auth verifier misconfig, TLS certificate/hostname/trust validation failure, explicit NATS authorization violation or credential expiry, protocol violation | terminal, actionable |
| unknown | a cause that cannot be structurally classified | terminal and loud; do not create an accidental infinite error loop |

Notes:

- `ENOTFOUND` is treated as transient because DNS/service discovery may appear
  after the gateway starts; a typo will retry until an operator reloads fixed
  config, with rate-limited logs.
- TLS transport interruption/timeouts are transient. Certificate validation,
  hostname mismatch, and trust-chain failures are permanent.
- A WebSocket close before first PONG is typed at the low-level close boundary.
  An earlier structured NATS/TLS/HTTP cause always wins; the later close event
  cannot overwrite it. Otherwise classify the RFC 6455 code **before** applying
  any early-disappearance default:

  | Close code | Startup class | Reason |
  |---|---|---|
  | no code/1005, 1000, 1001, 1006 | transient | ordinary or abnormal pre-handshake disappearance may recover |
  | 1011, 1012, 1013, 1014 | transient | server error/restart/try-later/gateway outage |
  | 1002, 1003, 1007, 1009, 1010 | permanent | structured protocol/data/size/extension incompatibility |
  | 1008 | unknown (terminal) | policy violation may hide auth/config; no supported transient meaning |
  | 1004, 1015, unlisted 3xxx/4xxx | unknown (terminal) | reserved/TLS-ambiguous/application-private without an allowlist |

  Any future private-code retry mapping must be an explicit low-level allowlist
  with tests; it cannot fall through to transient. Preserve the numeric code and
  only a reason-present flag in the startup error. Raw server close reasons are
  untrusted and may contain control bytes or secrets, so they never enter
  `operatorMessage`, status, or logs; diagnostics emit the allowlisted code and
  mapped label only.
- Handle WebSocket `unexpected-response` explicitly and preserve its HTTP status:
  408/425/429 and 5xx are transient; 401/403 are permanent authentication
  failures; other 3xx/4xx are permanent endpoint/configuration failures.
- Parse known NATS `-ERR` protocol values once in `nats-transport.ts` into a
  typed `NatsServerError`; lifecycle code does not message-match them. Explicit
  authorization violation/credential expiry is permanent, authentication timeout
  is transient, and malformed/unknown protocol errors are permanent/unknown.
- NATS protocol reference distinguishes authorization violations from
  authentication timeouts:
  <https://docs.nats.io/reference/reference-protocols/nats-protocol>.
- This classification governs the new **initial startup** loop. Existing
  established-connection reconnect behavior remains a separate state machine.

## 8. Logs and account status

### 8.1 Structured transition logs

Use stable event/state fields (serialized according to the existing string-only
logger capability) with a concise text fallback:

```text
event=webchannel.account_startup
accountId=<id>
state=retry_scheduled|permanent_skip|recovered|stopped
attempt=<n>
delayMs=<n>
code=<typed-code>
```

Logging policy:

- `retry_scheduled`: warning on the first failed attempt and every tenth failed
  attempt thereafter; status updates on every attempt need not emit a log.
- `recovered`: one info log, including failed-attempt count and outage duration.
- `permanent_skip`: one error per account/config generation, with remediation.
- invalid account IDs: one error per invalid key/config generation.
- aggregate zero/partial/complete serving counts: log only when category changes,
  not on every retry.
- never log user JWTs, seeds, signatures, full credential contents, or raw relay
  URLs. Relay display is allowlisted to `protocol + hostname + explicit port`;
  username, password, path, query, and fragment are always removed.
- render untrusted/invalid account IDs through one control-safe JSON formatter in
  every boot/doctor log surface. Newlines and other control bytes must never be
  interpolated raw.

### 8.2 OpenClaw account snapshot

Drive supported `ChannelAccountSnapshot` fields through `ctx.setStatus`:

| Lifecycle | `connected` | `restartPending` | `reconnectAttempts` | Other fields |
|---|---:|---:|---:|---|
| starting | false | false | 0 | set `lastError: null` |
| retry scheduled | false | true | failed-attempt count | sanitized `lastError` |
| serving | true | false | 0 | set `lastConnectedAt`, `lastError: null` |
| permanent failure | false | false | failed-attempt count | actionable `lastError` |
| stopped | false | false | 0 | no outage error on intentional stop |

Every `ctx.setStatus` call includes `accountId`, as required by the pinned
`ChannelAccountSnapshot` type. Use only verified fields; do not invent custom
snapshot keys. The existing status/doctor adapter continues to expose runtime
issues from these snapshots.

The private disconnect listener is stateful: the synchronous commit flips it
from `private` to `published` mode without detaching/re-attaching and therefore
without an event gap. After commit, identity-fenced transport listeners keep
live status truthful:

- established `disconnect` sets `connected: false`, a structured/sanitized
  `lastDisconnect`, `lastError`, and `restartPending: true` while internal
  reconnect is pending;
- `reconnect` sets `connected: true`, updates `lastConnectedAt`, and clears
  `lastError`/`restartPending`;
- terminal transport error updates the error fields without claiming recovery;
- an aborted/stale owner or disposed runtime performs no status write.

Invalid IDs cannot have host account snapshots because they are deliberately
excluded from `listAccountIds`; their runtime visibility is the structured boot
error plus static doctor finding.

## 9. Doctor behavior

Add `invalid-account-id` to `DoctorCheckId` and inspect raw account keys before
`planAccounts` or credential loading.

For each invalid key, report:

- the exact key using safe JSON rendering;
- the accepted `/^[A-Za-z0-9_-]{1,64}$/` rule and blocked prototype keys;
- that the account was not started; and
- a fix that tells the operator to rename the config key and re-run account
  setup/enrollment so credential paths and JWT audience stay aligned.

The warning prefix is also untrusted input: valid IDs may keep the conventional
`channels.webchannel.<id>` form, while invalid IDs use a control-safe bracketed
form such as `channels.webchannel.accounts["bad\nkey"]`. No formatter may raw-
interpolate an invalid key before or after the finding message.

`evaluateWebchannelDoctor` must never throw because one account ID or persisted
credential file is malformed. Its per-account credential/auth resolution is
also isolated so remaining findings are returned.

Replace the current source-contract assumption that exactly five `continue`
statements in `index-nats.ts` equal doctor parity. After extraction there is no
batch skip loop. Preserve the useful invariant with behavior tests over the
shared preflight result/check catalog: every permanent preflight code either maps
to a doctor finding or is explicitly runtime-only (for example a remote NATS
authorization rejection).

## 10. Detailed test plan

Use Vitest fake timers and injected clock/random/dial factories. No test should
sleep or reach a real network.

### 10.1 Account inspection and doctor

1. Mixed `good`, `bad.id`, blocked, empty/oversized keys: only valid sorted IDs
   are listed/planned; every invalid key gets a doctor finding.
2. One invalid key never prevents findings or plans for valid accounts.
3. Explicit all-invalid accounts map returns `[]`, not `["default"]`.
4. Flat/absent/empty config retains implicit `default` compatibility.
5. No invalid ID reaches the injected persisted-credential loader.
6. IDs are never canonicalized on read.
7. An ID containing newline/control bytes is escaped in both boot logs and the
   doctor prefix/message; it cannot inject a second log line. In discovery/no-
   full-snapshot mode the reporter is a no-op, and injected reporter/logger
   throws never change mixed valid results or the all-invalid `[]` result.

### 10.2 Backoff and classification

8. Classify the complete error-code matrix, including NATS authorization vs
   authentication timeout and TLS transport vs certificate failures.
9. Cover the full pre-PONG WebSocket close-code table: transient disappearance/
   service codes, permanent protocol codes, terminal policy/private/reserved
   unknowns, and an earlier typed NATS/TLS cause winning over every later close.
   A close reason containing a fake secret, newline, and control bytes is absent
   from error text, status, and logs; only code/mapped label/reason-present remain.
10. HTTP upgrade 503/429 is transient; 401/403 and other endpoint 4xx are
    permanent with sanitized messages.
11. Full-jitter bounds are `[0, ceiling)`; ceilings progress 1s, 2s, 4s ... 60s
   and never exceed 60s, including very large attempt counts without overflow.
12. Aborting a pending backoff clears its timer and schedules no dial.
13. Unknown errors are terminal.
14. Relay log formatting strips URL username, password, path, query, and hash,
    retaining only protocol/hostname/explicit port.

### 10.3 Per-account lifecycle

15. First two dials fail transiently and third succeeds: one runtime is committed,
    register subscription/wiring occurs exactly once, and no process restart is
    needed.
16. Many transient failures then success: one timer/dial at a time, correct cap,
    first/every-tenth/recovered logs, and correct status transitions.
17. One healthy and one retrying account: healthy runtime is never rebuilt or
    disconnected; aggregate state is partial until recovery.
18. Permanent preflight and explicit NATS auth rejection make no retry and keep
    the account task dormant until abort.
19. Tool-discovery registration neither installs durable dependencies nor
    changes owner/runtime state. Repeated full registration refreshes future
    durable dependencies but starts no work and leaves active state intact.
20. Consecutive full registrations with equal-content/different-reference
    `api.config` values reuse one install generation. `ctx.cfg` is a third,
    distinct object and startup succeeds; when its values deliberately differ,
    every account config read uses `ctx.cfg`.
21. An accidental same-generation overlapping `startAccount` performs no second
    dial and stays dormant rather than returning early. It resolves if its own
    host aborts first, or may become the single replacement only after the prior
    owner releases.
22. A newer generation arriving while the old host signal is live waits without
    aborting or ending the old composite task. After old host abort, the runtime
    is immediately absent from routing but the newest waiter acquires only after
    a deliberately delayed disposer resolves; a stale older start never
    supersedes it, and old cleanup cannot delete the new runtime.
23. Full-install fingerprints `A -> B -> A` produce monotonically ordered
    generations 1 -> 2 -> 3 rather than reusing stale generation 1.
24. Shared issuer/audience remains warning-only at runtime and a doctor error;
    both accounts' serving decisions remain independent of the collision and
    startup order.

### 10.4 Teardown and stale completion

25. Abort during backoff: timer removed, no late dial, no runtime.
26. Abort during DNS/WebSocket/NATS handshake: underlying transport disconnects
    and the account task settles well inside the five-second host timeout.
27. Force a dial promise to resolve after abort: generation/owner fence prevents
    runtime publication and disconnects the transport.
28. Old host aborts while its build is pending, completes cleanup/releases, and
    then a waiting new config generation acquires: any forced old late success
    cannot overwrite or delete the new runtime.
29. Failure after transport connection at each wiring checkpoint disconnects the
    private transport and publishes nothing.
30. Delay JWKS preparation while injecting a register message: before commit
    there is no register subscription and no peer/handler side effect.
31. Abort immediately before commit causes zero SUB writes and no map entry.
32. PONG followed by disconnect before delayed JWKS resolves is never committed;
    even a forced complete reconnect that restores `connected: true` cannot clear
    the sticky poison. The private runtime is disposed and a fresh transient
    attempt starts.
33. Keep a long debounce pending, abort, and advance all timers: no inbound turn,
    ACK/publish, queued follow-up, or timer remains.
34. Pause an already-running flush inside an awaited dedupe call, dispose, then
    release it: post-await fences prevent late ACK, dispatch, and recursive
    dispatcher follow-up.
35. Inject a serving-status or final publication failure and a delayed disposer:
    map/primary/status roll back synchronously, the task does not propagate until
    disposal finishes, and no background socket/subscription remains.
36. Abort after serving synchronously unpublishes only the owned runtime before
    awaiting its delayed disposer. Across separate cases, inject a failure in
    every status/rebind/disposer phase and assert every remaining cleanup phase
    still runs, the shared disposer runs once, `released` resolves once in
    `finally`, and the owner slot clears. With confirmed physical closure, the
    highest non-aborted/non-stale waiter is promoted exactly once. Injected
    promotion failure leaves no half-owner and old cleanup cannot delete a
    subsequently promoted runtime.
37. Exercise physical shutdown independently: graceful `ws.close()` throws and
    the socket remains `OPEN`; graceful close never emits `close`; forced
    `terminate()` succeeds; forced termination throws or never reaches `CLOSED`;
    and the transport logical closed flag is true while the socket remains open.
    Every case settles within the two configured bounds, reports force-attempt
    and physical-close evidence truthfully, and removes temporary timers and
    listeners.
38. With an unconfirmed physical close, map/primary/disposed gates remain fenced
    and `released` resolves exactly once, but no waiting task opens a replacement
    socket. Pre-quarantine waiters cannot spin a cleanup attempt or resolve while
    quarantine remains. A strictly later ordinary waiter performs one bounded
    cleanup under a single probe lease. On another unconfirmed result, its
    promise and all concurrent arrivals remain pending until their host abort,
    the lease releases/cutoff advances exactly once, and no automatic repeat or
    dial occurs. On success, cover exact all-waiter eligibility, highest-
    generation/FIFO selection, the probe promoting itself when it wins, and a
    pre-quarantine waiter winning when it is newer. Also cover unchanged-config/
    same-generation reload, concurrent probe selection, and abort of the selected
    probe during both confirmed and unconfirmed outcomes.
39. Hold each JWKS warm source path forever in separate deterministic cases:
    URL fetch before headers, URL response body, and file read. Abort the child
    after NATS PONG and assert the subscriber, account task, and confirmed
    transport shutdown settle well inside the five-second host bound; all
    abort/deadline listeners and timers are removed; and no readiness log,
    register SUB, map/primary entry, serving status, or late commit appears even
    if the abandoned source resolves later. With another live cache subscriber,
    the aborted startup subscriber exits immediately without cancelling the
    survivor; with no survivor, the source controller aborts and a late result
    cannot populate the cache or clear a newer inflight operation.

### 10.5 Connection-listener ownership

40. Failure and abort remove handshake-only listeners/timers and close their
    sockets; successful connect retains operational listeners until explicit
    disconnect/socket close.
41. Unexpected HTTP upgrade response drains/destroys the response and socket for
    transient and permanent status classes.

### 10.6 Routing, binding, and composition

42. Non-default account recovers first and becomes primary; a later `default`
    recovery supersedes it; default teardown selects lexicographically smallest
    remaining runtime.
43. Approval transport resolution remains account-specific throughout retry,
    recovery, and teardown.
44. Host abort waits for both approval monitor and NATS cleanup.
45. Unexpected rejection/resolution of either composed task aborts and awaits its
    sibling before returning.
46. Established disconnect updates the owned account snapshot to disconnected
    with `restartPending: true`;
    reconnect restores it and clears the error without creating a second runtime.
47. A stale/disposed runtime's late disconnect/reconnect event cannot overwrite
    the newer owner's status.
48. Existing post-establishment reconnect replays subscriptions without creating
    a second account runtime.

### 10.7 Regression gates

49. Existing single-account and multi-account plugin tests remain green.
50. `npm test`, `npm run typecheck`, and `npm run build` pass for the plugin.
51. Bundle/source inspection confirms no inbound listener is introduced and the
    entry contains no async `registerFull`, global startup latch, or batch account
    connect loop.

## 11. Expected file-level changes

| File | Planned change |
|---|---|
| `packages/plugin/index-nats.ts` | thin synchronous registration; move build logic; remove latch/batch; install coordinator; retain lazy facade wiring |
| `packages/plugin/src/nats-account-runtime.ts` (new) | per-account preflight/build/retry/commit/teardown coordinator, physical-close quarantine/probe ownership, and dynamic primary selection |
| `packages/plugin/src/channel.ts` | inject and safely compose NATS lifecycle with approval monitor |
| `packages/plugin/src/account-config.ts` | structured raw-ID inspection; valid-only listing without canonicalization |
| `packages/plugin/src/multiplex.ts` | plan valid IDs and/or expose single-account planning helper |
| `packages/plugin/src/doctor.ts` | invalid-ID finding and per-account exception isolation |
| `packages/plugin/src/nats-transport.ts` | typed NATS/connect/early-close/HTTP-upgrade errors, abortable initial handshake, disconnect cause, and bounded confirmed physical shutdown |
| `packages/plugin/src/nats-channel.ts` | idempotent listener/subscription/handler disposal seam |
| `packages/plugin/src/inbound-queue.ts` | disposal gate/cleanup support required to prevent queued follow-up turns |
| `packages/plugin/src/ingress-dedupe.ts` | post-await/pre-ACK/pre-dispatch lifecycle fences for flush/cancellation |
| `packages/plugin/src/auth.ts` | thread the account child signal into startup JWKS readiness and distinguish lifecycle abort from readiness failure |
| `packages/plugin/src/jwks.ts` | abortable shared-source subscribers, URL/body/file cancellation, and late-operation cache fences |
| `packages/plugin/src/nats-credential-source.ts` | thread signal/typed connector failure while retaining attempt ownership |
| `packages/plugin/src/consume-credentials.ts` | thread abortable connection dependency and preserve structured missing-creds outcome |
| relevant `*.test.ts` files | behavior, fake-timer, abort race, status/log, and regression coverage |
| `packages/plugin/src/index-nats-wiring.test.ts` | replace brittle skip-count contract with new lifecycle/wiring contracts |
| changelogs/docs if required by repo convention | operator-visible recovery and invalid-account behavior |

File names may be adjusted during implementation, but the ownership boundaries
and directly testable extraction are requirements.

## 12. Implementation order

1. Add account-ID inspection, control-safe formatting, and doctor coverage first.
2. Add typed early-close/HTTP/NATS/connect errors, abortable connect and JWKS
   warm paths, deterministic config fingerprint/backoff helpers, and listener-
   ownership tests.
3. Extract the existing account builder without changing auth/admission behavior;
   add its complete disposer and prove wiring/cleanup with tests.
4. Wrap the builder in the mode/config-aware account coordinator and
   transaction-style cleanup.
5. Move startup ownership from full-mode `registerFull` to composed
   `gateway.startAccount`; remove
   the latch and batch loop.
6. Add fenced startup/established status transitions, sanitized logs, and dynamic
   primary binding.
7. Run the full plugin test/typecheck/build gates and inspect the bundle.

Keeping extraction and lifecycle changes separable makes regressions easier to
localize even if they land in one pull request.

## 13. Completion criteria

The implementation is complete only when all of the following are demonstrated
by tests:

- a malformed account ID cannot stop a valid account;
- a transient initial outage recovers without gateway restart;
- transient retries are per-account, indefinite, capped, jittered, and
  rate-limited in logs;
- pre-handshake close-code classification retries only the explicit transient
  matrix; protocol/policy/private unknowns stop and raw close reasons never reach
  operator output;
- permanent/unknown failures remain terminal and actionable;
- at most one startup loop and one published runtime exist per account;
- abort/reload cannot leak a timer, socket, subscription, approval monitor, or
  queued follow-up/late runtime;
- abort during any Phase-C JWKS URL/header/body/file wait releases the account
  and its already-connected transport inside the host stop bound, without a late
  readiness diagnostic or commit;
- a runtime becomes externally reachable/discoverable only in the final
  synchronous, connected, owner-fenced commit;
- tool-discovery and repeated same-config full registration cannot disturb live
  account lifecycle state;
- account startup uses `ctx.cfg` even when full-registration config is a distinct
  object, and structural generations serialize reload overlap without locally
  terminating a live host task;
- owner leases survive through synchronous unpublication and complete disposal;
  release is unconditional and exactly once even when cleanup reports errors,
  but a waiter is promoted only after physical socket closure is proven;
- an unconfirmed socket close quarantines only that account, retains a bounded
  cleanup handle, and prevents every replacement dial until a later lifecycle
  cleanup probe confirms closure; a failed probe remains pending, advances its
  arrival cutoff once, and cannot manufacture another probe or core restart;
- primary and account-targeted routing remain correct as accounts recover/stop;
- invalid IDs appear in doctor without being canonicalized or used as paths;
- shared-audience warning/doctor semantics remain unchanged;
- established disconnect/reconnect keeps supported account status truthful;
- logs escape invalid IDs and redact every non-origin component of relay URLs;
- observability uses structured logs and supported OpenClaw account status only;
  and
- all plugin tests, typecheck, and bundle build pass.

## 14. Adversarial review record

- Round 1: **NOT CONVERGED** — P0 0, P1 5, P2 3, P3 1. All findings accepted
  and folded into rev2. Full report:
  [`issue-52-59/PLAN-REVIEW-r1.md`](issue-52-59/PLAN-REVIEW-r1.md).
- Round 2: **NOT CONVERGED** — P0 1, P1 2, P2 2, P3 1. All findings accepted
  and folded into rev3. Full report:
  [`issue-52-59/PLAN-REVIEW-r2.md`](issue-52-59/PLAN-REVIEW-r2.md).
- Round 3: **NOT CONVERGED** — P0 0, P1 1, P2 2, P3 2. All findings accepted
  and folded into rev4. Full report:
  [`issue-52-59/PLAN-REVIEW-r3.md`](issue-52-59/PLAN-REVIEW-r3.md).
- Round 4: **NOT CONVERGED** — P0 0, P1 1, P2 0, P3 0. The finding is accepted
  and folded into rev5. Full report:
  [`issue-52-59/PLAN-REVIEW-r4.md`](issue-52-59/PLAN-REVIEW-r4.md).
- Round 5: **NOT CONVERGED** — P0 0, P1 1, P2 0, P3 0. The finding is accepted
  and folded into rev6. Full report:
  [`issue-52-59/PLAN-REVIEW-r5.md`](issue-52-59/PLAN-REVIEW-r5.md).
- Round 6: **NOT CONVERGED** — P0 0, P1 1, P2 0, P3 0. The finding is accepted
  and folded into rev7. Full report:
  [`issue-52-59/PLAN-REVIEW-r6.md`](issue-52-59/PLAN-REVIEW-r6.md).
- Round 7: **NOT CONVERGED** — P0 0, P1 1, P2 1, P3 0. Both findings are
  accepted and folded into rev8. Full report:
  [`issue-52-59/PLAN-REVIEW-r7.md`](issue-52-59/PLAN-REVIEW-r7.md).
- Round 8: **CONVERGED** — P0 0, P1 0, P2 0, P3 0. Complete rev8 was re-read
  against the relevant source and pinned host behavior. Full report:
  [`issue-52-59/PLAN-REVIEW-r8.md`](issue-52-59/PLAN-REVIEW-r8.md).

Each round re-reads this complete plan and the relevant source. A round converges
only when it reports zero open P0/P1/P2 (blocker/major) findings; minor editorial
findings may remain only if they cannot change implementation behavior and are
explicitly dispositioned.
