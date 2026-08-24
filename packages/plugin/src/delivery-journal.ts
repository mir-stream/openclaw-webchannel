/**
 * v6 delivery-render — THE PLUGIN-OWNED DELIVERY JOURNAL (issue #239, doc §15.2).
 *
 * Our plugin is the Telegram plugin AND the Telegram server; our client is the
 * Telegram app (doc §0). Today the plugin owns no store at all and history is
 * read back out of core's agent transcript, which is precisely what §0 forbids
 * (NOT-list N2). This is that store: an append-only, per-conversation ordered
 * log of `JournalEvent`s, which #240 replays through the SHARED reducer to serve
 * history — so `history == live` holds BY CONSTRUCTION rather than by two
 * implementations agreeing (doc §15.4).
 *
 * THIS HALF SHIPS THE STORE WITH NO CALL SITES. `openDeliveryJournal` takes an
 * explicit path and does not resolve config, read the environment, or know about
 * accounts; half 2 owns the wiring, and with it persist-before-publish (commit
 * the event BEFORE publishing its frame — N6, doc §16.2-2, reversing v5 §15.8's
 * commit-after).
 *
 * ── WHERE IT LIVES, AND WHY NOT WHERE THE DOC SAID ──
 *
 * Doc §15.2 says `resolveStateDir()` (core's shared state dir). This deviates:
 * the file goes in the existing per-tuple private directory,
 * `~/.openclaw-webchannel-v2/<namespaceId>/delivery-journal.sqlite`
 * (`storage-paths.ts`). The journal holds message PLAINTEXT, and this repo
 * already has a tenant/account-scoped private store for exactly that class of
 * data, with a validated namespace derivation (`storage-identity.ts`) and
 * owner-only directory handling (`private-file.ts:ensurePrivateDirectory`). The
 * conversation KEYS that protect this plaintext on the wire already live there;
 * putting the plaintext itself in core's shared state dir would give it strictly
 * LESS separation than its own keys. Inventing a second storage convention was
 * the other option, and that is worse than deviating from one doc line.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ──
 *
 * `journal_message` — the MATERIALIZED read model with stable rank, tombstones,
 * revisions and a projector checkpoint (doc §15.4) — is **#240's** table. It is
 * not here, and its absence is not a judgment that it is unnecessary. Likewise
 * typed `messageCreated`/`messageEdited`/`messageDeleted` events with a
 * monotonic revision are **#241** (doc §16.2-3/4); a second `bubble` for one
 * answer id is untyped last-write-wins until then, see `append` below.
 */
import { chmodSync } from "node:fs";
import { dirname } from "node:path";

import { configureSqliteConnectionPragmas } from "openclaw/plugin-sdk/plugin-state-runtime";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";

import type { JournalEvent } from "./delivery-journal-event.js";
import { ensurePrivateDirectory } from "./private-file.js";

/**
 * `node:sqlite`, fetched through `process.getBuiltinModule` instead of a static
 * `import { DatabaseSync } from "node:sqlite"`.
 *
 * ⚠️ THIS IS NOT STYLE — a static import makes every vitest suite that loads
 * this module FAIL TO COLLECT. `node:sqlite` is a PREFIX-ONLY builtin, so
 * `builtinModules` lists it as `"node:sqlite"`; vite-node's `normalizeModuleId`
 * strips the `node:` prefix and looks the result up in a set that has the
 * PREFIXED name, decides `sqlite` is not a builtin, and asks the vite server to
 * load a package by that name (`vite-node/dist/utils.mjs` hardcodes exactly one
 * exception, `prefixedBuiltins = new Set(["node:test"])`). The observed failure
 * is `Failed to load url sqlite (resolved id: sqlite)`. Neither
 * `server.deps.external` nor a `pre` resolve plugin fixes it: by the time either
 * runs the specifier is already the bare `sqlite`.
 *
 * `process.getBuiltinModule` is a documented, stable API for exactly this — a
 * builtin fetched without going through the module loader — available since
 * Node 22.3.0, comfortably under this package's `engines.node` floor, and fully
 * typed (`typeof import("node:sqlite")`), so `DatabaseSync` keeps its real type.
 * The alternative was a root `vitest.config.ts` shim, which would put a
 * workaround for one module in the whole repo's test config.
 *
 * REVISIT when vitest/vite-node is upgraded past this bug: the plain import is
 * the better code, and this comment is the reason it is not here.
 */
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

/** Seeded into `journal_meta` on open. No migration gate exists yet — see `open`. */
export const DELIVERY_JOURNAL_SCHEMA_VERSION = "1";

const BUSY_TIMEOUT_MS = 5_000;

/**
 * One journaled row.
 *
 * `event` is parsed from `payload`, which is the TRUTH — `kind`, `message_id`
 * and `turn_id` are extracted columns that exist only so the log can be indexed.
 * `kind` here is read back off the parsed event, never off the column, so a row
 * can never report a kind its own payload contradicts.
 */
export type DeliveryJournalRow = {
  seq: number;
  kind: JournalEvent["kind"];
  event: JournalEvent;
  createdMs: number;
};

export interface DeliveryJournal {
  /**
   * Append one event and return its per-conversation `seq`.
   *
   * `inserted: false` means an IDEMPOTENT no-op — the event was already in the
   * log and `seq` is the FIRST one's. Never throws on a duplicate.
   */
  append(
    conversationId: string,
    event: JournalEvent,
  ): { seq: number; inserted: boolean };
  /** Rows for one conversation in `seq` order, i.e. in egress order. */
  read(
    conversationId: string,
    options?: { afterSeq?: number; limit?: number },
  ): DeliveryJournalRow[];
  /**
   * Per-connection pragma values, as SQLite reports them.
   *
   * `synchronous` is per-CONNECTION state, so it is UNOBSERVABLE from a second
   * handle on the same file — which is why this seam exists. `FULL` is the
   * durability claim of §16.2-9, and a claim nothing can observe is a claim
   * nothing can pin; `delivery-journal.test.ts` pins it through here.
   */
  connectionPragmas(): { journalMode: string; synchronous: number };
  /** Checkpoint, stop WAL maintenance, and close the handle. Idempotent. */
  close(): void;
}

/**
 * Open (creating if absent) the delivery journal at an EXPLICIT path.
 *
 * Connection setup order is load-bearing — see the inline notes, especially the
 * chmod, which must happen before the first WRITE creates the WAL sidecars.
 */
export function openDeliveryJournal(options: {
  databasePath: string;
  /** Injectable clock. Tests pin `created_ms`; production passes nothing. */
  now?: () => number;
}): DeliveryJournal {
  const databasePath = options.databasePath;
  const now = options.now ?? Date.now;

  // 1. Owner-only (0700) directory, the same handling the credential and
  //    conversation-key stores get.
  ensurePrivateDirectory(dirname(databasePath));

  // 2. Open. SQLite creates the main file here, at 0666 & ~umask.
  const db = new DatabaseSync(databasePath);

  // 3. chmod 0600 before anything can create the WAL sidecars. SQLite copies
  //    the MAIN database file's mode onto `-wal`/`-shm` when it creates them, so
  //    a late chmod leaves world-readable sidecars holding message plaintext —
  //    the main file looks fine while the plaintext sits beside it at 0644.
  //
  //    ⚠️ MEASURED, and NOT where you would guess: the sidecars are NOT created
  //    by `PRAGMA journal_mode = WAL` (step 4). They appear at the FIRST WRITE,
  //    which here is step 6's DDL. So "before WAL is enabled" is sufficient but
  //    is not the real boundary — "before the first write" is. Moving this call
  //    to just after step 5 still passes; moving it after step 6 turns the
  //    sidecars 0644 and `delivery-journal.test.ts` red (verified both ways).
  //    Keep it here anyway: it is the earliest correct point, and it cannot be
  //    invalidated by a later statement being added above the DDL.
  chmodSync(databasePath, 0o600);

  // 4. busy-timeout / WAL / autocheckpoint, in the SDK's safe lock-retry order.
  //    Hand-rolling that ordering is how a store ends up wedged under a
  //    concurrent writer; `databasePath` also lets the helper refuse a network
  //    filesystem where WAL is unsafe.
  const maintenance = configureSqliteConnectionPragmas(db, {
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    databasePath,
    databaseLabel: "webchannel delivery journal",
  });

  // 5. FULL — and it has to be a raw `exec` AFTER step 4, because the SDK's
  //    option type admits `"NORMAL"` only, so this cannot be expressed through
  //    it. (Step 4 does not clobber it: the helper touches `synchronous` only
  //    when the caller passes the option, and we do not. The ordering is
  //    "SDK baseline first, then tighten what the baseline cannot say".)
  //    §16.2-9 is blunt about why NORMAL is not good enough: WAL + `NORMAL` can
  //    roll a COMMITTED transaction back on power loss, and a store that calls
  //    itself durable does not get to do that.
  //    The cost was MEASURED, not assumed — 2000 bubble appends, one IMMEDIATE
  //    txn each, real on-disk filesystem (zfs), same code path for both modes:
  //    p50 0.068 ms NORMAL vs 1.38 ms FULL; p99 0.25 ms vs 3.0-5.6 ms. FULL is
  //    ~20x NORMAL and still an order of magnitude inside the budget
  //    persist-before-publish can afford in front of an outbound frame, so the
  //    trade is paid. (Doc §15.2's 0.098 ms viability number was measured under
  //    an unstated sync mode; it matches NORMAL here, not FULL.)
  db.exec("PRAGMA synchronous = FULL");

  // 6. Schema. `CREATE ... IF NOT EXISTS` so opening an existing journal is a
  //    no-op.
  //
  //    ⚠️ There is NO version-negotiation gate yet: `schema_version` is seeded
  //    and never checked, so an older build opening a newer journal proceeds.
  //    Deliberate for this slice (the journal has no call sites and no on-disk
  //    installs to be older than), and it is the same runtime-version-skew
  //    problem the reducer's BOUNDARY 2 defers to #241/#246. Whoever makes the
  //    journal authoritative (#240) owns closing it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS journal_event (
      conversation_id TEXT    NOT NULL,
      seq             INTEGER NOT NULL,
      kind            TEXT    NOT NULL,
      message_id      TEXT,
      turn_id         TEXT,
      payload         TEXT    NOT NULL,
      created_ms      INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, seq)
    ) WITHOUT ROWID;

    CREATE UNIQUE INDEX IF NOT EXISTS journal_user_once
      ON journal_event(conversation_id, message_id) WHERE kind = 'user';
    CREATE UNIQUE INDEX IF NOT EXISTS journal_placement_once
      ON journal_event(conversation_id, message_id) WHERE kind = 'placement';
  `);
  db.prepare(
    "INSERT INTO journal_meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT DO NOTHING",
  ).run(DELIVERY_JOURNAL_SCHEMA_VERSION);

  // ── statements ──
  //
  // The seq allocation is per-CONVERSATION and runs INSIDE the append's
  // transaction. A DB-global AUTOINCREMENT would be simpler and is wrong: it is
  // exposed to the client as its gap-sync cursor, and the moment a SECOND
  // conversation writes, the first one's cursor sees phantom gaps and asks for
  // a difference that does not exist (doc §16.2-6).
  const selectNextSeq = db.prepare(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM journal_event " +
      "WHERE conversation_id = ?",
  );
  const insertEvent = db.prepare(
    "INSERT INTO journal_event " +
      "(conversation_id, seq, kind, message_id, turn_id, payload, created_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  );
  const selectExistingSeq = db.prepare(
    "SELECT seq FROM journal_event " +
      "WHERE conversation_id = ? AND kind = ? AND message_id = ?",
  );
  const selectRows = db.prepare(
    "SELECT seq, payload, created_ms FROM journal_event " +
      "WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
  );

  let closed = false;

  return {
    append(conversationId, event) {
      // One IMMEDIATE transaction per event (doc §15.2: per-bubble immediate
      // txn, measured viable). Appends are SYNCHRONOUS and in egress order —
      // never batch or defer them, because batching reorders (§15.8).
      return runSqliteImmediateTransactionSync(db, () => {
        const seq = Number(
          (selectNextSeq.get(conversationId) as { next: number }).next,
        );
        const kind = event.kind;
        const messageId = extractMessageId(event);
        const result = insertEvent.run(
          conversationId,
          seq,
          kind,
          messageId,
          extractTurnId(event),
          JSON.stringify(event),
          now(),
        );
        if (Number(result.changes) > 0) return { seq, inserted: true };

        // A conflict is only reachable through the two partial unique indexes,
        // i.e. a REPLAYED `user` or `placement`. Doc §15.8 mandates that a
        // failed journal append is retried NON-DESTRUCTIVELY, so a retry whose
        // first attempt actually landed is an ordinary event, not an error:
        // return the FIRST row's seq and report `inserted: false`. Writing the
        // row twice would put the user's message in history twice while live
        // shows it once (N8), and worse — `applyUser` blind-appends, so a
        // duplicated id makes a later `applySeal` index past the end and THROW
        // (the reducer's BOUNDARY 1 precondition).
        const existing = selectExistingSeq.get(conversationId, kind, messageId) as
          | { seq: number }
          | undefined;
        if (existing === undefined) {
          // Unreachable: the ONLY unique constraints besides the primary key
          // are those two partial indexes, and the primary key cannot collide
          // because `seq` was just allocated as MAX+1 inside this transaction.
          // Throwing beats returning a seq that names a different row.
          throw new Error(
            "webchannel: delivery journal append conflicted on no known row " +
              `(kind ${kind})`,
          );
        }
        return { seq: Number(existing.seq), inserted: false };
      });
    },

    read(conversationId, readOptions) {
      const afterSeq = readOptions?.afterSeq ?? 0;
      // SQLite reads a negative LIMIT as "no limit".
      const limit = readOptions?.limit ?? -1;
      const rows = selectRows.all(conversationId, afterSeq, limit) as Array<{
        seq: number;
        payload: string;
        created_ms: number;
      }>;
      return rows.map((row) => {
        // `payload` is the truth, so the whole event round-trips VERBATIM —
        // including fields and even KINDS this build does not know about. #253:
        // retain, never silently drop. That is also why `kind` is taken from
        // here and not from the column.
        const event = JSON.parse(row.payload) as JournalEvent;
        return {
          seq: Number(row.seq),
          kind: event.kind,
          event,
          createdMs: Number(row.created_ms),
        };
      });
    },

    connectionPragmas() {
      const journalMode = db.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      const synchronous = db.prepare("PRAGMA synchronous").get() as {
        synchronous: number;
      };
      return {
        journalMode: journalMode.journal_mode,
        synchronous: Number(synchronous.synchronous),
      };
    },

    close() {
      if (closed) return;
      closed = true;
      // `maintenance.close()` clears the periodic-checkpoint interval the SDK
      // installed. Skipping it leaks a timer per opened journal.
      maintenance.close();
      db.close();
    },
  };
}

/**
 * The indexed id for an event, or `null` when the kind has none.
 *
 * `bubble` is DELIBERATELY NOT DEDUPED even though it has a message id, and the
 * asymmetry with `user`/`placement` is the point rather than an oversight: the
 * 4-kind model is last-write-wins by answer id, so a SECOND bubble for one id is
 * a legitimate EDIT of that bubble — the client's `applyBubble` upserts it in
 * place. Deduping it would silently discard the edit. (#241 turns that into a
 * typed `messageEdited` with a monotonic revision, at which point the duplicate
 * question gets a real answer instead of an omission.) `seal` needs no dedupe
 * either: the fold is keyed by answer id, so replaying one is harmless.
 *
 * The `default` is NOT an exhaustiveness hole — it is #253's retain rule. A
 * forward event kind read back from a newer build's journal is out of the union
 * at RUNTIME even though the switch is exhaustive at compile time; it stays
 * whole in `payload` and simply goes unindexed.
 */
function extractMessageId(event: JournalEvent): string | null {
  switch (event.kind) {
    case "user":
      return event.id;
    case "placement":
    case "bubble":
      return event.answerId;
    case "seal":
      return null;
    default:
      return null;
  }
}

/** The indexed turn id. Read structurally so a forward kind still indexes it. */
function extractTurnId(event: JournalEvent): string | null {
  const turnId = (event as { turnId?: unknown }).turnId;
  return typeof turnId === "string" ? turnId : null;
}
