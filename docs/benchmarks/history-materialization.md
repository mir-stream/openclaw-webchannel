# Materialized history (#286)

History snapshots and pages now query a persisted canonical read model. The raw
SQLite journal remains authoritative and append-only. Normal repeated pages and
pages after reopen select their requested rows without replaying raw events or
hydrating the conversation.

## Reproduce

Run from the worktree, with its own dependencies, under the shared host lock:

```sh
flock /tmp/openclaw-webchannel-round1-checks.lock node --expose-gc scripts/benchmark-history.mjs --sizes 1000,5000,10000,20000 --runs 2 --hot-inserts 600 --output docs/benchmarks/history-materialized.json
```

The old implementation can be compiled directly from Git without another checkout:

```sh
flock /tmp/openclaw-webchannel-round1-checks.lock node --expose-gc scripts/benchmark-history.mjs --baseline-ref 914c6e3 --sizes 1000,5000,10000,20000 --runs 2 --output /tmp/history-baseline-rerun.json
```

For an independent old/new comparison on **the same SQLite journal**, add
`--oracle /tmp/webchannel-round4-baseline-projection.mjs` to the candidate command.
That is the coordinator's immutable bundle of develop `914c6e3`; it exports
`serveHistoryRequest` and `projectJournalHistory`. Each standard-fixture measured page is asserted
against that oracle outside candidate timing. `oracleElapsedMs` times the separate
old full-projection call. The committed candidate run used this option.

The script creates and deletes only its own synthetic fixture directory. It records
Node/platform, code hashes, setup time, individual observations, memory, raw and
derived work counts, disk size, and dense-insertion distributions. `sha` identifies
the checkout; `sourceHashes` identify the measured code even before a results commit.

## What is measured

- **Read:** `createHistoryServer.sendSnapshot` / `servePage` until `sendHistory`,
  including scheduled catch-up and frame selection. Real SQLite, WAL and
  `synchronous=FULL`; limit 50. Frame sizing here uses deterministic JSON byte
  measurement; transport and encryption are excluded. Separate integration tests
  exercise the actual channel, sealed envelope, browser decoder and wrapper.
- **Setup:** each raw append uses the production transaction path. Fixture insertion,
  bundling, explicit GC, and version-reset setup are outside read timing.
- **Streams:** distinct ~1.2 KB bubbles; and a mixed stream of users/origins,
  placements, reasoning, bubbles, sparse tools, approval pairs, and seals that
  reorder answers and retain absent-removal tombstones.
- **Scenarios:** cold build, unchanged recent page, preceding page, deep page,
  close/reopen, one appended delta, and two schema-version rebuilds per fixture.
  Runs share the fixture; each adds one extra event, reported explicitly.
- **Counters:** `materializedRowsRead` counts reducer dependency rows;
  `pageRowsRead` and `cursorRowsRead` count selected wire rows and cursor matches.
  Identity metadata reads are separate. Cold raw reads can exceed applied events:
  a time slice can stop before consuming its 128-row read-ahead. Applied-event
  counters count work attempted, including a transaction later retried for rank
  exhaustion. Rank writes are separate from content writes.
- **Memory:** heap difference after the timed operation is allocation/retention
  evidence, not a peak heap measurement. RSS includes SQLite and the benchmark's
  retained fixture. A 1 ms heartbeat measures event-loop pauses; it is not a hard
  latency guarantee.

## Results

All times below are milliseconds; ranges show the two observations. Materialized
results measure the sources in initial PR head `00fa6ce0c672abec9a3e40f1d1d0ee24efb721b2`.

| Stream | Raw events | Baseline unchanged | Materialized unchanged | Deep page | Reopen | Cold build | Version rebuild |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| bubbles | 1000 | 11.08–12.86 | 1.06–1.07 | 1.46–1.65 | 1.50–1.77 | 117.32 | 93.36–98.31 |
| bubbles | 5000 | 147.18–167.73 | 1.40–1.43 | 1.58–1.80 | 1.16–1.33 | 601.06 | 768.29–1216.84 |
| bubbles | 10000 | 659.94–666.66 | 1.02–1.61 | 1.46–1.59 | 1.41–1.49 | 1070.91 | 1043.20–1056.43 |
| bubbles | 20000 | 3259.58–3703.79 | 1.58–2.49 | 5.11–8.44 | 1.74–1.79 | 1912.15 | 1868.82–2142.21 |
| mixed | 1000 | 14.33–19.92 | 0.74–1.03 | 1.04–1.11 | 1.07–1.14 | 98.43 | 84.09–87.49 |
| mixed | 5000 | 219.69–267.20 | 0.87–0.97 | 1.18–1.26 | 1.02–1.14 | 445.71 | 687.72–1222.04 |
| mixed | 10000 | 626.43–875.28 | 1.10–1.17 | 1.57–2.28 | 0.96–1.23 | 915.62 | 896.95–919.29 |
| mixed | 20000 | 2713.87–2833.83 | 1.01–2.96 | 4.16–4.45 | 1.49–1.81 | 1869.93 | 1877.53–1969.05 |

Every unchanged/deep/reopen query read **0 raw events, 0 reducer-window rows,
wrote 0 derived rows**, and selected 50 page rows (deep cursors read one additional
index match). Both 20k fixtures' small-delta requests read/applied one raw event,
read one dependency row and wrote one materialized row; elapsed 3.32–5.74 ms for
mixed and 4.07–5.05 ms for bubbles. Existing-row updates are also structurally
tested: at most four dependency rows and one write.

| 20k fixture | Cold raw reads / applied | Dependency rows read / written | Batches | Cold peak heartbeat | Rebuild peak heartbeat (two) |
| --- | ---: | ---: | ---: | ---: | ---: |
| bubbles | 21099 / 20000 | 19999 / 20000 | 165 | 25.76 | 75.85–79.93 |
| mixed | 20595 / 20000 | 51661 / 23332 | 161 | 21.66 | 40.08–40.32 |

The version-reset DDL is synchronous: the largest measured 20k rebuild pauses
were **75.85–79.93 ms** for bubbles and **40.08–40.32 ms** for mixed, despite
cooperative folding. Cold builds were slower than baseline for small fixtures
(for example 1k bubbles: 117.32 ms versus a 15.59 ms baseline first request).
This pays the durable read-model construction once, not on each page.

At 20k events, setup took 29.31 s for bubbles and 27.08 s for mixed (baseline
37.49 s and 27.64 s). Single append timings were 3.44–4.92 ms and 4.65–4.80 ms;
append does no projection. DB + WAL + SHM at the recorded point totaled 77.53 MB
and 41.59 MB, versus baseline 27.80 MB and 21.05 MB. These include transient WAL
after rebuild, not only retained database bytes. There were 20,002 and 11,669
materialized rows, including hidden rows.

Unchanged 20k requests increased heap by about 268 KB (bubbles) and 218–222 KB
(mixed), while cold build increased it by 29.81 MB and 1.55 MB. GC timing affects
these deltas; RSS was about 226–253 MB and also includes fixture/oracle process
state. The JSON contains every observation rather than only a favorable run.

**Dense insertions:** 600 new answers repeatedly inserted among existing answer,
tool, reasoning and tombstone slots: query p50 **1.97 ms**, p95 **2.60 ms**,
max **55.74 ms**. Rebalancing wrote 2,322 ranks total, at most 128 per transaction;
final maximum rank length was 23, below the 64-character bound. Its final page
matched the frozen oracle; dense every-prefix correctness/fault/reopen is tested
separately. Hot-insertion append p50/p95/max: 1.35/1.47/5.08 ms.

Machine-readable evidence: [baseline](history-baseline-914c6e3.json) and
[candidate](history-materialized.json). All 112 standard-fixture measured pages
passed the frozen old-projection comparison on the same journal.

These are measurements of the named operations on this host, not CI timing gates.
The baseline artifact was measured before editing production code. Candidate code
hashes accompany its results and match initial PR head `00fa6ce`. A subsequent
convergence fix changed `history-serve.ts` to refresh a pending snapshot's finite
target when another browser registers. The full-size benchmark was not rerun for
that revision; the JSON preserves the original measured source hashes.

## Canonical state and ordering

Production dispatch is `history-serve.ts` → `serveHistoryRequestStep` → the open
journal's `historyPage`. The pure full replay remains the oracle and the fallback
for explicitly injected legacy readers. Ordinary journal handles always expose
the materialized query.

`DurableRowVersions.apply` and `applyDurableEvent` still decide content and order.
The canonical reducer implementation itself is unchanged. The shared
`applyDurableEventWindow` loads every explicitly addressed typed row, its immediate
neighbors, and the tail. Seal is the only operation that needs slot/neighbor/tail
context. Unchanged references anchor the omitted intervals, so running the same
reducer on this window preserves their positions. Storage encodes the resulting
order and updates only changed rows. It never matches identities by text or ordinal.

Persisted state:

| Table | State |
| --- | --- |
| `journal_history_row` | Injective JSON tuple key, complete durable JSON, modification seq, display rank, visibility, cursor fields and timestamp-fallback flag. Hidden tombstones remain present. |
| `journal_history_identity` | First-seen timestamp and original user randomId. IDs are JSON encoded, preserving Unicode/NUL and surrogate distinctions. The canonical **ID-only** timestamp semantics, including cross-kind/tool-turn sharing, remain unchanged. |
| `journal_history_checkpoint` | Version, committed log prefix, validity, next append rank, unsupported count, last timestamp, fallback count, and resumable rank-rebuild phase. |

Tools retain their `(turnId,id)` identity and complete sparse opener/terminal fields.
Text retains accepted content, role, placement, turnId, revision, edited/deleted
state. Reasoning and approval identity/pair resolution match full replay. Row seq
is a content modification version, never a display position. First appearances that
do not introduce a visible row and absent-removal tombstones survive checkpoints.

Rank strings encode only relative order. Ordinary appends use a fixed integer
prefix; inserted groups receive balanced fractional ranks. A rank is limited to
64 characters. Exhaustion rolls back the attempted batch and starts a persisted
rank rebuild: prepare replacement ranks, then apply them, in at most 128-row
transactions. Pages remain pending while replacement is incomplete. Reopen and
other handles resume that phase. No raw events are replayed for rank rebuilding.

The cursor index probes at most two visible matching IDs. A non-unique ID is
ambiguous; `beforeTurnId` disambiguates reasoning/tools using the existing rules.
Unknown cursors return an empty successful page. Direct fractional/NaN/infinite
limits retain the old slice semantics; production plans supply bounded integers.

## Checkpoint and recovery invariant

Every catch-up step starts an immediate SQLite transaction, captures a finite raw
prefix target, reads at most 128 raw rows, and folds until the row or ~8 ms work
budget. All content, rank, metadata and checkpoint writes commit together. A failed
step rolls back them all and propagates a read failure; the history server logs and
sends no frame. Already committed raw sends keep their acceptance and retry identity.

A finished page reads rows and checkpoint in the same transaction. If another
handle has advanced past a request's original target, the response publishes that
actual coherent checkpoint. It never samples a separate journal MAX after reading
rows. Raw difference continues to serve ordered journal events with the existing
individually oversized-event policy (#343).

Concurrent snapshot requests for one peer share a replay. A later registration
refreshes its finite target on the next scheduled step, covering events committed
before that browser subscribed. Subsequent appends alone do not move the target.
Page requests retain their separate concurrency latch.

Derived tables are created lazily on the first history query. Missing, incompatible,
or version-mismatched schema is recreated; invalid/missing/ahead checkpoints rebuild
the affected conversation. The version marker is checked on every query because a
metadata-only update does not change SQLite's schema cookie. Table shape, indexes
and invalidation triggers are checked on schema changes. Derived row/identity
mutations invalidate their checkpoint, making partial deletion recoverable.

There is no global conversation cache. Prepared statements belong to an open
journal handle; SQLite coordinates multiple handles. The account-specific file and
raw peer key scope every row. Closed handles cannot query another runtime's state.

## Costs and limits

- Durable append and startup do no materialization. Catch-up is paid by the history
  reader and adds derived storage/WAL writes; a small delta loads its affected
  dependency window. Unchanged pages perform no raw reads or derived rewrites.
- Cold build remains proportional to retained events and can take seconds. It
  yields between transactions rather than blocking for the whole replay. Seals
  pay for their addressed rows; one exceptionally large event is indivisible.
- Version rebuild includes synchronous schema/reset work before cooperative folding.
  The measured heartbeat maxima include that DDL/reset pause. The 8 ms budget does
  not preempt SQL, one reducer event, GC, transaction commit, or disk stalls.
- Dense rank rebuilding scans/writes derived positions twice in bounded batches;
  its total cost grows with conversation rows. It does not change raw history or
  silently impose a history-depth/key-growth gate.
- History uses SQLite immediate transactions, including warm selection. Concurrent
  handles serialize with writers under the journal's existing busy timeout.

## Validation

`materialized-history.test.ts` checks generated prefixes, repeated application,
full hidden state, reopen, sparse tools/approvals, timestamps/health/origins,
ambiguous/fractional pages, index query plans, bounded unchanged/deep/delta reads,
fault rollback, legacy fixtures, schema restoration, multiple handles/accounts/
peers, coherent high-water and dense rank-rebuild failure/reopen.

Existing durable-send fixtures now read through the materialized query and assert
full-replay equivalence: relay loss, failed-store same-ID retry, buffered-final FIFO,
independent final/reasoning IDs and reopen recovery. Encrypted history integration
covers >500-event warm recovery, byte-trimmed cold recovery, a cold browser joining
during pending snapshot catch-up, exact optimistic origin adoption, repeated
snapshots/pages and equal-version sparse terminal tool restoration.
Client recovery/receipt and account/peer routing fixtures remain part of focused
validation; the final-HEAD E2E Gate owns the full suite, packaging and live harnesses.

The coordinator's separate 24-seed generator passed 3,840 prefix checks, periodic
hidden-state comparisons, 2,184 pages and 120 reopen checks against frozen
`914c6e3` projection/version code in 23.38 s. This initial independent check predates
schema-shape/rank-input validation; it is not represented as final-HEAD CI evidence.
The coordinator then reran the initial PR code at 1k events for both streams (two
runs) and 600 dense insertions, checking the frozen oracle. All six production
hashes matched the full-size committed candidate artifact and `00fa6ce` sources.
That independent run measured warm unchanged 0.94–1.53 ms with zero raw /
window reads or rewrites; hot query p50/p95/max 2.64/3.72/69.07 ms, at most 128
rank writes per batch and final key length 23. The coordinator independently
inspected the full-size results. These measurements predate the subsequent
snapshot-registration convergence fix.

Before initial PR head `00fa6ce`, local validation completed under the shared lock:
client/plugin/E2E typechecks, workspace builds, exact one-worker collection
inventory, and focused canonical,
materialization, history-server, durable-send, encrypted recovery, client receipt,
account/peer isolation and ingress-identity tests. No full local suite was run.

## Telegram reference and deliberate difference

The inspected OpenClaw source at `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`
retains the server-returned message ID in Telegram `draft-stream.ts`'s
[`sendMessageTransportPreview`](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/extensions/telegram/src/draft-stream.ts)
and edits that handle;
[`rotateFinalizedStream`](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/extensions/telegram/src/lane-delivery-text-deliverer.ts)
rotates a finalized handle. The public
[messages.getHistory contract](https://core.telegram.org/method/messages.getHistory)
provides peer, offset-ID and limit paging. Telegram's
[updates contract](https://core.telegram.org/api/updates) separates message identity
from update sequences and recovers gaps and outgoing random-ID mappings.

Those contracts do not establish Telegram's internal schema or query complexity.
Our plugin also owns the server store, so it maintains the SQLite journal and this
rebuildable read model. It preserves our canonical reducer's ordering rather than
inventing a competing timestamp or modification-seq sort.
