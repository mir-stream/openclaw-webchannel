# Journal synchronization and instance identity

This is the protocol 7 contract for #413/#414, following #356, PR #362 and
PR #384. The plugin owns the journal and its sequence numbers; the client owns
the in-memory view, row versions, optimistic sends and recovery requests.

## Incomplete snapshots

A snapshot's `highWaterSeq` and selected rows come from the same SQLite read.
Byte fitting changes the window's contents, not the authority of that baseline.
A cold client seeds the high-water even when `snapshotComplete` is false. It
hydrates the rows it received and handles the next live sequence immediately.
It never requests `get_difference(0)` merely because the snapshot is incomplete.

`history.omitted` lists identities removed by byte fitting: `id`, optional
`kind`, tool `turnId`, and row modification `seq`. It covers both trimmed old
rows and individually oversized rows in the requested snapshot window. The
client exposes these as `state.historyOmissions`, separate from transcript
messages. A correlated history page clears only markers for valid rows with
an equal or newer version. A repeated snapshot replaces the omission window.

Older byte-trimmed rows are reachable using the existing `load_history` cursor.
An individually oversized row retains #311/#343's skip policy. Even an omission
identity can be too large for a pathological wire budget; in that case fitting
omits the markers, retains `snapshotComplete: false`, and serves the rows that
fit. All envelope metadata participates in actual encrypted-size measurement.
No content is truncated, fabricated, or removed from the journal. Write-side
chunking/refusal is #325; retention is #299.

A warm client keeps its genuine retained cursor and catches up only from that
floor, even if an incomplete snapshot arrives during the request. It keeps the
nonce, retry deadline and buffered frames. Warm gap recovery still holds live
durable frames until the missing range is covered, preserving order.

## Epoch lifecycle and upgrade

`journal_meta.epoch` is a randomly generated UUID identifying one journal
history. The journal seeds it once with insert-if-absent and reads the stored
winner. Multiple opens of the same file use the same value. A pre-epoch journal
takes this same additive upgrade; no events, user IDs, dispatch records,
idempotency mappings or materialized history are rewritten. An invalid stored
epoch refuses open instead of silently blessing an ambiguous identity.

Every production channel frame carries the epoch, including history pages,
snapshots, differences and ACKs. Live carriage matters: a new user commit or ACK
can beat the register snapshot. Sequence numbers and `webchannel-user-<seq>`
identities are meaningful only within that epoch. Injected legacy test adapters
without a journal identity remain usable; a client that has learned an epoch
ignores subsequent epochless frames.

| Event | Epoch | Client behavior |
| --- | --- | --- |
| Network reconnect or normal gateway restart | Retained | Keep view and cursor; recover a genuine gap |
| New journal after deletion/reset | New UUID | Cold reset before folding reused IDs |
| First open of a pre-epoch journal | New UUID | Establish the upgraded identity |
| Restore a journal backup | Renew before startup | Cold reset to the restored history |

On a change, the client retires the outstanding difference timer, old live
buffer, pending snapshots/pages, row-version and deletion fences, and old
server rows/activity. Unconfirmed local sends and their receipt/random-ID
linkage survive, so a first-frame ACK cannot merge a new send into an old
same-ID bubble. A matching new-epoch snapshot supplies the baseline directly;
if the first evidence is live traffic or a correlated difference, the client
requests the existing reconnect/register path to obtain a fresh snapshot.
Retired epochs are ignored. Difference/page correlation is checked before
allowing another epoch to invalidate the view.

The Telegram reference is `extensions/telegram/src/update-offset-store.ts`:
offsets survive unchanged bot/token identity and are discarded when that
identity changes or legacy state lacks its binding. This is the same identity
rule applied to the server history we own. No new intentional Telegram behavior
divergence is introduced. Client and plugin must ship together under the
existing unreleased protocol **7**, not protocol 8.

## Restoring a journal backup

An exact database copy includes its epoch. The plugin cannot distinguish an
unannounced file rollback from an ordinary restart using that copy alone.
Restoration must therefore establish a new history identity explicitly:

1. Stop the gateway. Restore a consistent SQLite backup at the exact journal
   path for the intended tenant/account. Do not combine the restored database
   with WAL, SHM or rollback sidecars from another database generation.
2. Before starting the gateway, remove only the restored identity metadata:

   ```sh
   node --input-type=module - /absolute/path/to/delivery-journal.sqlite <<'JS'
   import { statSync } from 'node:fs';
   import { DatabaseSync } from 'node:sqlite';
   const path = process.argv[2];
   if (!path || !statSync(path).isFile()) throw new Error('Expected an existing journal file');
   const db = new DatabaseSync(path);
   try {
     db.prepare("DELETE FROM journal_meta WHERE key = 'epoch'").run();
   } finally {
     db.close();
   }
   JS
   ```

3. Start the gateway. Its first journal open stores the replacement epoch
   before any history or live output is served. Open clients cold-reset on the
   first new-epoch frame. Subsequent normal restarts retain this epoch.

The command neither deletes events nor changes keys/credentials. Run it on the
restored file, not the backup source. This procedure does not authorize data
restoration during containment, replay external effects, or implement a backup
service. Ordinary file replacement that skips step 2 is unsupported and can
retain stale client state.

## Regression evidence

`e2e/history-convergence.test.ts` drives real SQLite materialization, production
history serving and NatsChannel encryption through the browser decoder and
wrapper. At 2,000 and 4,000 rows with an oversized row in the newest window, it
asserts N raw events applied, 50 projected page rows, no difference request and
immediate next-live delivery. Doubling N is bounded to twice the measured
storage row work plus constant overhead with the time-slice clock pinned (row-count
yielding remains active, independent of CI contention). The browser hydrates only the bounded
snapshot window; warm materialization reads only newly appended events.

Other focused regressions cover epoch persistence, legacy migration, a real
backup rollback with renewal, empty resets, retired epochs, pending-send ID
collisions, nonce isolation, canceled retry timers and close-during-reset.
The final pushed SHA's E2E Gate supplies full-suite and live-server validation.
