# Accepted request recovery (#369)

The chosen policy is option 2. If A was running while B was accepted and queued,
a restart makes A **Interrupted · result unknown** and automatically runs B.
The plugin never guesses whether an external effect happened from missing output.
The user can inspect retained output and deliberately choose **Retry** on A.

## Persistence and ownership

New normal requests with a usable wire ID store their original text, wire ID,
logical `random_id` (or wire fallback), exact raw peer and retry provenance beside
their server user row in one immediate SQLite transaction. The file's existing
namespace isolates tenant/account. Admission still reserves the shared count and
byte budget first; neither an ACK nor a dispatcher commit precedes persistence.
A failed transaction leaves no partial user/pending batch.

| State | Restart behavior |
| --- | --- |
| queued | Automatically offer the stored payload in conversation sequence order. |
| started | Persist interrupted; never automatically run again. |
| completed / failed | Retain the recorded result; never automatically run again. |
| interrupted | Show uncertain result with deliberate retry. |
| cancelled | Suppress original retransmissions permanently in this lifecycle store. |

An account owner token fences claims and settlement. A single transaction claims
all actual queued batch members before calling the handler. Cancellation excludes
members before merging, and batch completion updates every member. An account
replacement invalidates old starts, aborts active core calls, and refuses stale
channel output. Queue teardown retains durable queued work for the replacement.
A browser **unregister** or peer eviction is the same kind of teardown: it clears
only the in-memory dispatcher and session key, so rows already accepted stay
`queued` and the recovery pump runs them — the peer's stable key is reloaded from
the key store, and the missing-key case below applies unchanged. Their output is
journaled, and the device sees it on its next history load. On base, pending
buffered input was dropped on unregister; accepted work now always runs.
The recovery pump admits at most 32 rows per page through the existing bounded
dispatcher and continues without a browser retry. It restores an existing exact
peer key for outbound delivery only; browser inbound still requires registration.
Missing keys retain queued work; current DM admission policy still applies.

## Stop cancellation

The control lane owns a durable receipt keyed by the authenticated raw peer and
logical `random_id` (wire ID fallback). Its SQLite file is already scoped to the
exact tenant/account tuple. In one immediate transaction it stores the receipt,
exact IDs retained by debounce, all queued/started dispatch targets, and their
cancelled lifecycle events. A partial write rolls the entire stop back. No stop
ACK, target ACK, buffer retirement or abort signal precedes this commit. The
legacy cancellation callback also withholds ACK on persistence failure; its
memory fallback is not durable acceptance.

The live abort still bypasses the normal FIFO. It follows the synchronous SQLite
commit, without awaiting SDK outcome-store callbacks. A dispatcher lease holds
later starts until the first core control invocation settles, so a delayed
session-wide abort cannot reach new work. Account teardown drains that invocation
before permitting a replacement runtime. A stuck core control call therefore
holds that peer's new dispatch and account replacement; the receipt and target
suppression remain durable. Different control requests received while that core
call is pending get no ACK and rely on client retry; they allocate no waiting
control payload. Same-ID retries immediately receive the existing receipt.

After ACK loss or restart, the same stop only replays its receipt. It never
recaptures the current queue and never invokes core again. Cancelled original
inputs are recognized before hot outcomes, overflow resolution and ordinary
admission; store acceptance/claim also enforce suppression. A cancelled input
that already has a user row retains its original server ID and history. Inputs
cancelled before acceptance have only a tombstone, with no invented user row.
The receipt confirms the server's cancellation decision, not rollback of an
external effect. A process crash between commit and live abort needs no abort
replay: plugin dispatch is cancelled, and existing core restart retirement owns
any recorded started core run.

Only authorized explicit `/stop` clears queued/debounce input, using the existing
command gate. Broader abort vocabulary and refused commands retain their core
policy and have deduped control receipts without a buffered-input cancellation.
Core receives a stable message ID scoped by tenant/account/raw peer as an
additional dedupe layer. ID-less legacy controls have no retransmission identity;
conforming clients always supply one. Control user-bubble history remains the
separate #281 gap. This change does not migrate old SDK terminal markers or fix
their separate legacy namespace issue (review R5).

Control receipts and target metadata have the same indefinite on-disk retention
as dispatch lifecycle records; evicting them would permit old replays to execute.
No message payload is copied into the stop tables. Target capture uses the
existing bounded debounce reservations, and dispatch updates/notifications page
32 rows at a time without collecting a whole durable backlog. Dispatch schema 2
upgrades schema 1 transactionally; earlier schema-1 writers refuse the file.
There is no wire protocol or SDK pin change. Do not downgrade this database.

## Core restart recovery

Before entering core, the plugin records the exact isolated core session key and
store path in its dispatch journal. This does not freeze core session IDs: `/new`,
`/reset` and expiry can rotate them normally. An awaited plugin service reads
these prior-process bindings independently of account credentials and relay
readiness. It reads only the journals of THIS process's configured accounts — the
serving plan's own tuple directories — never every journal under a storage root, so
two gateway processes sharing one home cannot retire each other's live work and a
removed account's stale journal is never opened. Core marks previous-process
orphaned runs before plugin services and schedules automatic recovery after
services finish. The service retires only a
bound entry with `status=running` and `abortedLastRun=true`, using the public SDK
writer with an atomic current-entry comparison and required write success.
Newly active runs and unrelated session keys remain outside that predicate.

The pinned SDK can turn read/JSON errors into empty results. A strict backing-file
read and a consistency check therefore precede trusting its answer. Storage faults
keep the service's startup promise pending; even a throwing diagnostic cannot
release that barrier. New plugin dispatch waits for this service. When transport
startup fails it also writes interrupted status in the plugin journal — but only
for batches that reached `beforeCore` and therefore have a core binding. A started
batch that never reached core has no binding for this service to find and stays
`started` until the account runtime's own recovery pump marks it interrupted.

**The hold is deliberately wider than WebChannel.** Core awaits each plugin
service in sequence and schedules its own restart recovery only after that loop
finishes, so while this service is pending, every plugin service registered after
it, the gateway's post-ready sidecars and core's restart recovery for **every**
channel wait too. That ordering is what guarantees core's resumer never re-runs an
interrupted WebChannel turn; releasing early would race it. A persistent storage
fault, or a configuration error that prevents planning a served account, therefore
holds the whole gateway's remaining startup — loudly, one error line per second
naming the fault — until the fault clears. This is the chosen trade-off: an
operator-visible startup hold over a silent duplicate external effect.
There are no private core imports, permission-dependent conversation hooks or
operator configuration changes.

## Client and upgrade

`requestState` belongs to the server user row and survives raw difference,
materialized history, client recreation and older-page replay. It is separate from
transport acceptance. Existing successful output is retained. The app renders
**Interrupted · result unknown. Check any effects before retrying.** and a Retry
button. `retryInterrupted(serverMessageId)` creates new wire/random IDs and carries
`retry_of` pointing to the original server ID; the server validates that provenance
within the same peer. Provenance that does not name an interrupted request of that
peer is DROPPED, not refused: the message is accepted and runs as an ordinary send
with no recorded `retryOf`, so one bad value can never refuse the batch it arrived
in. An automatic retransmission retains its original IDs.

Only lifecycle-bearing requests accepted by this build have recovery evidence.
Historical rows get no new status and cannot become queued merely because an
optimization marker expires. Marker-without-row repair remains available.
Id-less legacy sends still execute, but have no durable dispatch recovery.
The new dispatch schema rejects future versions before migrations; the history
projection is rebuilt at version 2. Existing credential/key downgrade guards remain.
Older binaries cannot enforce a lifecycle they do not understand: do not downgrade
with pending work. Client and plugin must deploy together at protocol version 5.

## Evidence boundaries

Focused tests use real SQLite, public SDK stores and production ingress/dispatcher.
Six deterministic SIGKILL cases recreate OS processes around accept/start/effect,
queued batches and cancellation, followed by repeated recovery. Core-service tests
inject core restart state through the public SDK, including a rotated session ID,
read failure and throwing logger; these are controlled boundary tests. A real
registered wrapper and demo DOM test hydrate journal-derived history, recreate the
widget, and click Retry. The E2E Gate additionally exercises the real gateway and
provider loop, including a `/new` turn through durable dispatch. None of these
checks prove exactly-once behavior in arbitrary external tools.

[Stop coordinator regressions](../packages/plugin/src/stop-control.test.ts) combine
production ingress, debounce, dispatch recovery and real SQLite/public SDK stores.
They cover ACK loss, later-turn protection, stalled lookups/writes and overflow,
authorization, tuple isolation, retention, schema upgrade and partial transaction
failure. [Three stop crash cases](../packages/plugin/src/stop-crash.test.ts) kill
OS processes before commit, after commit before ACK, and inside the stop ACK
callback, then reopen twice and retransmit originals and the same stop. The core
recipient and ACK sink are controlled: these tests prove SQLite/process boundaries,
not real browser/NATS/core delivery. The prior audit's R1 microtask probe and R2
source trace were narrower evidence. The existing E2E Gate supplies broader
real-gateway validation; it is not a live reproduction of these fault injections.

The core integrity check is tied to the pinned public SDK's JSON session-store
format. It reads the complete backing file, checks the relevant identity/state
against the SDK result, and verifies the bytes did not change during the read.
It does not treat a swallowed SDK read error as an empty history. An unsupported
future format or a persistent read/write failure holds startup until retirement
can be verified. The configured accounts' journal directories — default or custom
root — must remain available while their accepted work is pending.
