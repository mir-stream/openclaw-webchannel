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
The recovery pump admits at most 32 rows per page through the existing bounded
dispatcher and continues without a browser retry. It restores an existing exact
peer key for outbound delivery only; browser inbound still requires registration.
Missing keys retain queued work; current DM admission policy still applies.

## Core restart recovery

Before entering core, the plugin records the exact isolated core session key and
store path in its dispatch journal. This does not freeze core session IDs: `/new`,
`/reset` and expiry can rotate them normally. An awaited plugin service reads
these prior-process bindings independently of account credentials and relay
readiness. Core marks previous-process orphaned runs before plugin services and
schedules automatic recovery after services finish. The service retires only a
bound entry with `status=running` and `abortedLastRun=true`, using the public SDK
writer with an atomic current-entry comparison and required write success.
Newly active runs and unrelated session keys remain outside that predicate.

The pinned SDK can turn read/JSON errors into empty results. A strict backing-file
read and a consistency check therefore precede trusting its answer. Storage faults
keep the service's startup promise pending; even a throwing diagnostic cannot
release that barrier. New plugin dispatch waits for this service. The service also
writes interrupted status in the plugin journal when transport startup fails.
There are no private core imports, permission-dependent conversation hooks or
operator configuration changes.

## Client and upgrade

`requestState` belongs to the server user row and survives raw difference,
materialized history, client recreation and older-page replay. It is separate from
transport acceptance. Existing successful output is retained. The app renders
**Interrupted · result unknown. Check any effects before retrying.** and a Retry
button. `retryInterrupted(serverMessageId)` creates new wire/random IDs and carries
`retry_of` pointing to the original server ID; the server validates that provenance
within the same peer. An automatic retransmission retains its original IDs.

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

The core integrity check is tied to the pinned public SDK's JSON session-store
format. It reads the complete backing file, checks the relevant identity/state
against the SDK result, and verifies the bytes did not change during the read.
It does not treat a swallowed SDK read error as an empty history. An unsupported
future format or a persistent read/write failure holds startup until retirement
can be verified. Default and configured custom journal roots must remain available
while their accepted work is pending.
