/**
 * v6 delivery-render — THE PLUGIN-OWNED DELIVERY JOURNAL (issue #239, doc §15.2).
 *
 * Our plugin is the Telegram plugin AND the Telegram server; our client is the
 * Telegram app (doc §0). The plugin used to own no store at all, and history was
 * read back out of core's agent transcript — precisely what §0 forbids
 * (NOT-list N2). This is that store: an append-only, per-conversation ordered
 * log of `JournalEvent`s, which #240 replays through the SHARED reducer to serve
 * history — so `history == live` holds BY CONSTRUCTION rather than by two
 * implementations agreeing (doc §15.4).
 *
 * `openDeliveryJournal` takes an explicit path and does not resolve config, read
 * the environment, or know about accounts. #239 halves 2 and 3 landed the wiring
 * — the account-start open in `nats-account-runtime.ts`, the egress seam in
 * `nats-channel.ts`, and the inbound-accept seam in `ingress-dedupe.ts` — and
 * with it persist-before-publish (commit the event BEFORE publishing its frame —
 * N6, doc §16.2-2, reversing v5 §15.8's commit-after).
 *
 * ⚠️ AND THE READER LANDED. #240 half 1 added `journal-history.ts` (the
 * projection); half 2 wired it to both live read sites and DELETED the core
 * transcript path, so this store is now the ONLY history source there is. Notes
 * below that still turn on "nothing reads it" are therefore stale wherever they
 * survive — each one that mattered has been re-argued in place; treat any that
 * has not as a defect, not as a premise.
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

// Type-only, so it is erased before vite-node ever sees a `node:sqlite`
// specifier — see `loadNodeSqlite` for why a VALUE import would break collection.
import type {
  DatabaseSync as SqliteDatabase,
  StatementSync as SqliteStatement,
} from "node:sqlite";

import {
  MAX_INBOUND_USER_ID_LENGTH,
  type JournalEvent,
} from "./delivery-journal-event.js";
import { ensurePrivateDirectory } from "./private-file.js";

/** Main database plus every journal-mode sidecar that can hold database pages. */
const SQLITE_DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

/**
 * Seeded into `journal_meta` on open. No migration gate exists yet — the note is
 * at step 6 in `openJournalConnection`.
 */
export const DELIVERY_JOURNAL_SCHEMA_VERSION = "1";

/**
 * SQLite lock-wait before a busy error.
 *
 * ⚠️ DELIBERATELY 5 s, NOT core's 30 s (`OPENCLAW_SQLITE_BUSY_TIMEOUT_MS` in
 * `openclaw`'s `src/state/openclaw-state-db.ts`). `busy_timeout` is a
 * SYNCHRONOUS block: `DatabaseSync` parks the whole event loop for the wait, so
 * the worst case here is the value chosen, not an async delay. Persist-before-
 * publish puts this in front of every outbound frame, and a 30 s freeze of the
 * gateway is a worse failure than a journal append that gives up (§15.8). Core's
 * 30 s is right for core: its state DB is the authority and there is no frame
 * waiting behind it.
 *
 * ⚠️ RE-ARGUED AT #240 HALF 2, WHICH IS WHERE THE OLD JUSTIFICATION DIED. It
 * used to end "the journal is still a SHADOW store, so a refused append costs
 * nothing a retry cannot recover", and the cutover made the journal the only
 * history store. So price the two sides honestly:
 *  - A REFUSED APPEND now costs a real row. At egress the send proceeds anyway
 *    (`nats-channel.ts`'s `journalOutbound` warns and returns), so the peer saw
 *    that bubble live and will not see it on reconnect; at the inbound accept
 *    the batch is rejected and the CLIENT may retry — ⚠️ weaker than it sounds, and `ingress-dedupe.ts` retracts the strong form two seams over: the ledger is capped at `MAX_UNACKED = 100` and lost on reload, and a retry recovers neither #282's ordering nor #283's orphan row.
 *  - A 30 s BUSY WAIT still freezes the whole gateway synchronously, for every
 *    peer, because `DatabaseSync` parks the event loop.
 * 5 s stays: the freeze is unbounded in blast radius and the loss is one frame
 * with a loud, throttled diagnostic. But it is now a TRADE, not a free choice,
 * and the honest fix for the losing side is fail-closed egress (refuse the
 * publish when the append fails), not a longer wait here.
 */
const BUSY_TIMEOUT_MS = 5_000;

/** Memoized `node:sqlite`; see `loadNodeSqlite`. */
let nodeSqlite: typeof import("node:sqlite") | undefined;

/**
 * Resolve `node:sqlite` through `process.getBuiltinModule` instead of a static
 * `import { DatabaseSync } from "node:sqlite"`, LAZILY and memoized.
 *
 * ⚠️ THE INDIRECTION IS NOT STYLE — a static import makes every vitest suite
 * that loads this module FAIL TO COLLECT. `node:sqlite` is a PREFIX-ONLY
 * builtin, so `builtinModules` lists it as `"node:sqlite"`; vite-node's
 * `normalizeModuleId` strips the `node:` prefix and looks the result up in a set
 * that holds the PREFIXED name, concludes `sqlite` is not a builtin, and asks
 * the vite server to load a package by that name (`vite-node/dist/utils.mjs`
 * hardcodes exactly one exception, `prefixedBuiltins = new Set(["node:test"])`).
 * The observed failure is `Failed to load url sqlite (resolved id: sqlite)`.
 * Neither `server.deps.external` nor a `pre` resolve plugin fixes it: by the
 * time either runs, the specifier is already the bare `sqlite`.
 *
 * ⚠️ AND THE LAZINESS IS NOT STYLE EITHER. Destructuring at module top level
 * makes a Node built `--without-sqlite` fail with a bare `Cannot destructure
 * property 'DatabaseSync' of undefined` at IMPORT time — and half 2 puts this
 * module in the plugin's main import graph, so that would take the whole plugin
 * down at load, with an error naming neither the journal nor SQLite. Resolving
 * inside `openDeliveryJournal` confines the failure to the journal and lets it
 * say what is actually wrong.
 *
 * `process.getBuiltinModule` is documented and stable for exactly this — a
 * builtin fetched without going through the module loader — and fully typed
 * (`typeof import("node:sqlite")`), so `DatabaseSync` keeps its real type.
 *
 * The binding requirement is `node:sqlite` ITSELF, which is what forces a modern
 * Node here; `process.getBuiltinModule` (Node 22.3.0) is strictly older than
 * that and never the constraint. Do NOT justify either against this package's
 * `engines.node` — that range is copied verbatim from the `openclaw` PEER's own
 * declaration, so citing it as evidence for a floor this file needs is circular
 * (the same commit introduced both). The peer is the source of the range; this
 * module is a consumer of it.
 *
 * REVISIT when vitest/vite-node is upgraded past this bug: the plain import is
 * the better code, and this comment is the reason it is not here.
 */
function loadNodeSqlite(): typeof import("node:sqlite") {
  if (nodeSqlite === undefined) {
    // Annotated as optional on purpose: the typed overload promises a module,
    // but the runtime returns `undefined` for a builtin this binary lacks.
    const resolved: typeof import("node:sqlite") | undefined =
      process.getBuiltinModule("node:sqlite");
    if (resolved === undefined) {
      throw new Error(
        "webchannel: the delivery journal requires the node:sqlite builtin, " +
          "which this Node binary does not provide (a build configured " +
          "--without-sqlite). Run the gateway on a standard Node matching this " +
          "package's engines range.",
      );
    }
    nodeSqlite = resolved;
  }
  return nodeSqlite;
}

/**
 * An event kind this build does not know — #253's retain rule, in the type
 * system. A newer build's journal can hold kinds only IT understands, and the
 * store keeps them whole in `payload` rather than dropping them.
 */
export type UnknownJournalEvent = { kind: string } & Record<string, unknown>;

/** What `read` can actually hand back: a known event, or a retained unknown one. */
export type RetainedJournalEvent = JournalEvent | UnknownJournalEvent;

/**
 * One journaled row.
 *
 * `event` is parsed from `payload`, which is the TRUTH — `kind`, `message_id`
 * and `turn_id` are extracted columns. `kind` here is read back off the parsed
 * event, never off the column, so a row can never report a kind its own payload
 * contradicts.
 *
 * ⚠️ `kind` IS `string` AND `event` IS `RetainedJournalEvent`, NOT `JournalEvent`
 * — deliberately, and the friction that creates for consumers is the point. A
 * row read out of a journal a NEWER build wrote can carry a kind outside the
 * union (#253 retains it), so typing this field as `JournalEvent["kind"]` would
 * be a knowing lie, and the lie has a specific victim: `applyDurableEvent`'s
 * `switch` has no `default`, so an out-of-union kind falls off the end, returns
 * `undefined`, and the NEXT event throws — pointing at the wrong event (the
 * reducer's header documents this at length).
 *
 * ✅ AND THAT WARNING LANDED — the prediction here was that #240 would "lift the
 * `read(...).map((row) => row.event as DurableEvent)` shape straight out of
 * `delivery-journal.test.ts`". It did not: `journal-history.ts` wrote
 * `isKnownJournalEvent`, a `Record<JournalEvent["kind"], true>`-derived filter
 * that counts out-of-union rows into `unsupportedEvents` and keeps them away
 * from `applyDurableEvent` entirely. Recorded as an outcome rather than deleted,
 * because the POINT of the paragraph is unchanged and is now load-bearing for a
 * real consumer: `kind` is `string` and `event` is `RetainedJournalEvent` ON
 * PURPOSE, and that friction is what made the cast visibly a claim instead of a
 * fact. Do not "tidy" either field to `JournalEvent`; the next consumer needs the
 * same push.
 */
export type DeliveryJournalRow = {
  seq: number;
  kind: string;
  event: RetainedJournalEvent;
  createdMs: number;
};

export interface DeliveryJournal {
  /**
   * Append one event and return its per-conversation `seq`.
   *
   * `inserted: false` means an IDEMPOTENT no-op — a row was already in the log
   * under this event's `(conversationId, kind, message id)`, and `seq` is THAT
   * row's. A duplicate NEVER throws; that is the point of it, since §15.8
   * mandates non-destructive retry of a failed append.
   *
   * ⚠️ THE PAYLOAD IS NOT COMPARED. `inserted: false` says a row exists under
   * that id, NOT that it holds the same event — so a caller that reuses an id
   * for genuinely different content gets the FIRST content kept and the second
   * silently discarded, indistinguishable from an ordinary retry. That is
   * exactly the shape of **#275**: the accept seam's own dedupe
   * (`ingress-dedupe.ts`) is WINDOWED — 7-day TTL, bounded `stateMaxEntries` —
   * while `journal_user_once` has no window, so a client id reused after
   * eviction is new to the seam and a duplicate here. Whoever wires the seam
   * (#240) owns reconciling the two lifetimes; do not read this flag as proof
   * the stored event matches the one you passed.
   *
   * `conversationId` is UNVALIDATED and unbounded, unlike a `user` id — it is
   * copied into every row plus each index entry, so that is only sound while it
   * stays PLUGIN-DERIVED. Nothing in this package derives one yet; half 2
   * invents it. If it ever comes from a client-supplied field, bound it at the
   * seam the way `ingressDedupeKey` bounds `user_message.id`.
   *
   * ⚠️ IT DOES THROW on a malformed `user` event. Those are the only two
   * VALIDATION refusals — a SQLite fault (a corrupt file, a failed lock) still
   * propagates like any other:
   *  - `kind: "user"` whose `id` is empty or not a string. Distinct user
   *    messages under one id collapse onto a single row, and the loser comes
   *    back as `inserted: false` — indistinguishable from the ordinary retry
   *    above — so its text is simply absent from the only SSOT user messages
   *    have (doc §15.7);
   *  - `kind: "user"` whose `id` exceeds `MAX_INBOUND_USER_ID_LENGTH` (128, the
   *    bound `ingress-dedupe.ts` already applies to this client-supplied field).
   *    An unbounded id is amplified three times per row.
   *
   * Both are USER-KIND-ONLY. A `placement` under `answerId: ""` is faithful and
   * is accepted; agent ids are plugin-minted and are never length-checked,
   * because refusing one would drop delivered text (N10).
   */
  append(
    conversationId: string,
    event: JournalEvent,
  ): { seq: number; inserted: boolean };
  /**
   * #243 half 2a (doc §16.2-1) — journal a FRESH inbound user message under a
   * SERVER-MINTED durable id, and RETURN that id so the accept seam can echo it.
   *
   * The id is minted INSIDE the same transaction that allocates `seq`
   * (`webchannel-user-<seq>`), which is the whole reason this is a distinct entry
   * point rather than `append(journalEventForInboundUser(...))`: §16.2-1 requires
   * the durable id be assigned transactionally WITH the seq, and the loose
   * `nextMessageId()` mint used at egress is not tied to this store's txn. So the
   * caller supplies only the CONTENT (`text`, the wire `turnId`, and the client
   * `random_id`); the identity is this store's to assign.
   *
   * `turnId` STAYS the client's wire id (the client still holds it and stamps it
   * on its live user bubble); only the message `id` moves to the server. See the
   * accept seam's mirror argument.
   *
   * IDEMPOTENT on the stable key `randomId ?? turnId` (turnId = the wire id the
   * client reuses on every replay) — mirroring `ingressDedupeKey`. A replay of a
   * message already journaled returns the FIRST row's `seq` and minted
   * `messageId` with `inserted: false`, and writes NO second row. This is the
   * journal-level net that replaces the old `journal_user_once`-on-wire-id
   * collapse, which stopped working once the durable id became server-minted (a
   * replay would otherwise mint a DIFFERENT id and duplicate the row). It matters
   * because persist-before-publish can commit a row and then have its batch
   * refused, after which the client replays.
   *
   * `randomId` is also what `lookupUserMessageIdByRandomId` recovers a minted id
   * by for the deduped-retry echo. Pass `undefined` for an older client that sent
   * no usable `random_id`: it is still journaled (keyed by its wire id) and still
   * idempotent, but carries no `random_id` echo.
   *
   * ⚠️ PRECONDITION: `randomId` (and `turnId`) are CALLER-VALIDATED. Both are
   * stored and `randomId ?? turnId` is INDEXED, but this method does not re-bound
   * them — the caller (`ingress-dedupe.ts`) already gates them through `usableId`
   * (non-empty, ≤ 128), which is what makes `randomId ?? turnId` equal
   * `ingressDedupeKey`'s keyBody. See the method body's note (#270: bound what you
   * index, at the door).
   */
  appendInboundUser(
    conversationId: string,
    input: { text: string; turnId?: string; randomId?: string },
  ): { seq: number; inserted: boolean; messageId: string };
  /**
   * #243 half 2a — the server user messageId previously minted for `randomId` in
   * this conversation, or `undefined` if none. This is the deduped-retry echo's
   * lookup: when the ingress dedupe catches a retry before it re-appends, this
   * recovers the id the FIRST admission assigned so the ack echoes it unchanged.
   */
  lookupUserMessageIdByRandomId(
    conversationId: string,
    randomId: string,
  ): string | undefined;
  /**
   * Rows for one conversation in `seq` order, i.e. in egress order.
   *
   * UNBOUNDED BY DEFAULT, on purpose: replaying the whole log is what the shared
   * reducer does to produce history, so a silent default page size would produce
   * a silently truncated history.
   *
   * ⚠️ THIS METHOD *IS* THE PAGINATION PATH, not a stopgap ahead of one. #240
   * half 1's `journal-history.ts` serves a page by a FULL CHUNKED REPLAY off
   * exactly this call — `read(conversationId, { afterSeq, limit })` in a loop —
   * because the reducer is the only thing allowed to decide order, and a
   * materialized table not yet proven equivalent to a replay would be a second
   * opinion about it (N8). Doc §15.4's read model is still the right
   * destination; it is deferred, not adopted, and **#286** tracks it with the
   * replay's measured cost.
   *
   * ⚠️ THE DEFAULT IS ALSO A MEMORY DECISION, and #240 answered it by NEVER
   * CALLING IT unbounded: an unbounded read materializes AND `JSON.parse`s the
   * entire conversation log into memory SYNCHRONOUSLY, blocking the event loop
   * for the duration. Measured at 20 000 rows of ~1.2 KB that is ~75 ms and
   * ~25 MB of live objects. The projection chunks instead, so the unbounded
   * default survives for callers that genuinely want the whole log (tests, and
   * the store's own round-trip assertions) rather than as the history path.
   *
   * `afterSeq` must be a non-negative integer and `limit`, when given, a
   * positive one; both throw rather than degrade.
   */
  read(
    conversationId: string,
    options?: { afterSeq?: number; limit?: number },
  ): DeliveryJournalRow[];
  /** Checkpoint, stop WAL maintenance, and close the handle. Idempotent. */
  close(): void;
}

/** The prepared statements one journal connection owns. */
type JournalStatements = {
  selectNextSeq: SqliteStatement;
  insertEvent: SqliteStatement;
  selectExistingSeqByKind: { user: SqliteStatement; placement: SqliteStatement };
  selectRows: SqliteStatement;
  /** #243 half 2a: idempotency check-first, and the deduped-retry echo lookup. */
  selectUserByIdempotencyKey: SqliteStatement;
};

/**
 * #243 half 2a — mint a user message's DURABLE id from its per-conversation
 * `seq`, INSIDE the append transaction that allocated it (doc §16.2-1).
 *
 * ⚠️ THE `user-` INFIX IS WHAT KEEPS THIS COLLISION-FREE WITH AGENT IDS, and it
 * is load-bearing, not decoration. Agent ids are `nextMessageId()`'s
 * `webchannel-<ms>-<6 chars>` (`message-adapter.ts`), where the segment after
 * `webchannel-` is DIGITS (`Date.now()`); this one is `webchannel-user-<seq>`,
 * where that segment begins with `user`. The two namespaces cannot overlap, so a
 * server user id can never be mistaken for — or collide with — an agent bubble id
 * in the shared `message_id` column.
 *
 * ⚠️ UNIQUENESS COMES FROM `seq`, WHICH IS THE POINT. `seq` is `MAX(seq)+1` per
 * conversation, allocated in this same transaction and never reused (append-only,
 * no deletes), so `webchannel-user-<seq>` is unique within the conversation — the
 * exact scope `journal_user_once` keys on — BY CONSTRUCTION. Deriving the id FROM
 * `seq` is the most direct expression of "assigned transactionally with the seq":
 * there is no second source of truth to keep in step.
 */
function mintServerUserMessageId(seq: number): string {
  return `webchannel-user-${seq}`;
}

/**
 * Steps 3-6 of the open sequence, plus the statements, on an ALREADY-OPEN handle.
 *
 * Split out so `openDeliveryJournal` can wrap the whole thing in one `try` and
 * close the handle if any of it throws — see the call site.
 */
function openJournalConnection(
  db: SqliteDatabase,
  databasePath: string,
): {
  maintenance: ReturnType<typeof configureSqliteConnectionPragmas>;
  statements: JournalStatements;
} {
  // 3. chmod 0600 before anything can create the WAL sidecars. SQLite copies
  //    the MAIN database file's mode onto `-wal`/`-shm` when it creates them, so
  //    a late chmod leaves world-readable sidecars holding message plaintext —
  //    the main file looks fine while the plaintext sits beside it at 0644.
  //
  //    ⚠️ MEASURED, and NOT where you would guess: the sidecars are NOT created
  //    by `PRAGMA journal_mode = WAL` (step 4). They appear at the FIRST WRITE,
  //    which here is step 6's DDL. So "before WAL is enabled" is sufficient but
  //    is not the real boundary — "before the first write" is.
  //
  //    ⚠️ AND NO TEST PINS THIS POSITION. An earlier version of this comment
  //    said moving the call after step 6 "turns the sidecars 0644 and
  //    `delivery-journal.test.ts` red (verified both ways)". That held while the
  //    sweep covered only the MAIN file; it stopped holding in this same commit,
  //    once the sweep grew to cover `-wal`/`-shm` explicitly — run late, it
  //    finds them already on disk and hardens them regardless. RE-MEASURED: both
  //    orderings end at `main 0600, -wal 0600, -shm 0600`.
  //
  //    So what the early call buys is narrower than "the sidecars are 0600": it
  //    is the absence of a WINDOW in which they exist at 0644 while another
  //    process could open them. That window is real and it is unguarded — a
  //    single-process end-state assertion cannot see it. Keep the call here: it
  //    is still the earliest correct point and cannot be invalidated by a later
  //    statement being added above the DDL. Just do not believe a test will
  //    catch you moving it.
  //
  //    ⚠️ AND IT CHMODS THE SIDECARS TOO, NOT JUST THE MAIN FILE. Inheritance
  //    only covers sidecars SQLite CREATES; it never re-chmods one that already
  //    exists, so a journal whose sidecars were loosened — by a crash, a
  //    restore, or a build predating this sweep — keeps them loose while the
  //    main file looks correct. Core does the same sweep over the same four
  //    names (`resolveSqliteDatabaseFilePaths` in `openclaw`'s
  //    `src/infra/sqlite-files.ts`, applied by `ensureOpenClawStatePermissions`).
  //    `-journal` is in the list because `configureSqliteConnectionPragmas`
  //    silently falls back to `journal_mode = DELETE` on a network volume.
  //
  //    MEASURED, because the obvious version of this claim is wrong: SQLite
  //    DELETES AND RECREATES a stale `-wal` on reopen, so that one comes back
  //    0600 by inheritance anyway. The file that actually survives at 0644 is
  //    the `-shm`, which SQLite leaves exactly as it finds it. It holds the WAL
  //    INDEX rather than message plaintext, so the exposure is narrower than
  //    "plaintext at 0644" — but it is real, it is what core's sweep covers, and
  //    it is the assertion `delivery-journal.test.ts` uses to catch this
  //    regressing (verified red when the sweep is cut back to the main file).
  chmodDatabaseFiles(databasePath);

  // 4. busy-timeout / WAL / autocheckpoint, in the SDK's safe lock-retry order.
  //    Hand-rolling that ordering is how a store ends up wedged under a
  //    concurrent writer; `databasePath` also lets the helper refuse a network
  //    filesystem where WAL is unsafe.
  const maintenance = configureSqliteConnectionPragmas(db, {
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    databasePath,
    databaseLabel: "webchannel delivery journal",
  });

  try {
    // 5. FULL. ⚠️ THIS EXEC ASSERTS INTENT; IT DOES NOT CHANGE BEHAVIOUR TODAY.
    //    MEASURED: a fresh `node:sqlite` handle already reports `synchronous = 2`
    //    (FULL) before any pragma, and step 4 leaves it at 2 — FULL is this
    //    build's DEFAULT and NORMAL is the opt-out, so this line is currently a
    //    no-op. It stays because `configureSqliteConnectionPragmas` ACCEPTS a
    //    `synchronous: "NORMAL"` option (its type admits that one value and no
    //    other): the day an SDK bump or a shared helper starts passing it, step 4
    //    would silently downgrade this store, and this exec is what takes the
    //    downgrade back. §16.2-9 is why the downgrade must not stand — WAL +
    //    `NORMAL` can roll a COMMITTED transaction back on power loss, and a store
    //    that calls itself durable does not get to do that. It has to be a raw
    //    `exec` after step 4 for the same reason: `"FULL"` cannot be expressed
    //    through that option type at all.
    //
    //    ⚠️ NOT UNIT-PINNED, and it cannot cheaply be: `synchronous` is
    //    per-CONNECTION state, invisible from a second handle, and an assertion on
    //    THIS connection would pass with this line deleted (it is the default).
    //    An honest test would need a second process and a power-loss simulation.
    //
    //    The cost of NOT downgrading was MEASURED rather than assumed — 2000
    //    bubble appends, one IMMEDIATE txn each, real on-disk filesystem (zfs),
    //    identical code path, only the pragma varied: p50 1.38 ms FULL vs 0.068 ms
    //    NORMAL, p99 3.0-5.6 ms vs 0.25 ms. So the ~20x is what we DECLINE TO
    //    RECOVER by downgrading, not a cost we opted into, and 1.38 ms is well
    //    inside what persist-before-publish can afford in front of an outbound
    //    frame. (Doc §15.2 quotes p50 0.1 ms and states no mode; the 0.098 ms
    //    figure is §14.8's, and that one DOES state its mode — `WAL +
    //    synchronous=NORMAL + busy_timeout`. Both are NORMAL numbers, and §14.8's
    //    p99 4.1 ms and 393 ms auto-checkpoint spike match the tail seen here.)
    db.exec("PRAGMA synchronous = FULL");

    // 6. Schema. `CREATE ... IF NOT EXISTS` so opening an existing journal is a
    //    no-op.
    //
    //    ⚠️ A PLAIN ROWID TABLE, NOT `WITHOUT ROWID`, AND THE CHOICE IS MEASURED.
    //    `WITHOUT ROWID` is the intuitive pick for a (conversation_id, seq)-keyed
    //    append-only log: it clusters rows in exactly `read`'s scan order. It is
    //    also the wrong pick here, because the whole ROW lives in an INDEX b-tree,
    //    whose `maxLocal` is ~1008 B against a table b-tree's ~4084 B — so every
    //    record between those sizes buys a whole extra 4 KB overflow page, and a
    //    chat bubble sits squarely in that band.
    //
    //    A/B on this exact DDL, 20 000 rows, VACUUMed, only the clause varied,
    //    real filesystem; `read()` = full-conversation scan, SQL then JSON.parse:
    //
    //      payload   WITHOUT ROWID              rowid table
    //      200 B     6.84 MB   3.6/1.3 ms       7.20 MB   28.5/12.8 ms
    //      1.2 KB    92.18 MB  256/30.2 ms      27.73 MB  75.5/12.4 ms
    //      4 KB      92.18 MB  367/32.4 ms      92.55 MB  240/34.8 ms
    //                          (single/interleaved read)
    //
    //    At the dominant ~1.2 KB size the rowid table is 3.3x SMALLER and 2-3x
    //    FASTER to read — the clustering advantage is swamped by walking 3.3x more
    //    pages. The counter-argument does survive at 200 B, where there is no
    //    overflow: interleaved reads are ~10x faster clustered (1.3 ms vs 12.8 ms).
    //    That band is real but it is not ours, and it loses the disk axis anyway.
    //
    //    This is IRREVERSIBLE in practice — see the missing version gate below —
    //    so it is written down rather than left silent.
    //
    //    ⚠️ There is NO version-negotiation gate yet: `schema_version` is seeded
    //    and never checked, so an older build opening a newer journal proceeds.
    //    Deliberate for this slice, and it is the same runtime-version-skew
    //    problem the reducer's BOUNDARY 2 defers to #241/#246. Filed as
    //    **#271**, which owns the residual risk; whoever makes the journal
    //    authoritative (#240 **half 2**) owns closing it.
    //
    //    ⚠️ ONE THING, AND ONLY ONE, MAKES THE GAP TOLERABLE: there are still no
    //    deployed installs whose build could be older than a journal on disk.
    //    That is not a property of this slice and it expires the day this ships
    //    to a real deployment — so do not read the survival of the gap through
    //    another slice as evidence that it is cheap.
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
        -- #243 half 2a: the STABLE idempotency key a fresh user row was admitted
        -- under — the client random_id when it sent one, else its wire id — which
        -- mirrors ingress-dedupe.ts's ingressDedupeKey keyBody exactly. It gives
        -- a user row an idempotent identity that survives the durable id moving
        -- from client-minted to server-minted: appendInboundUser is idempotent on
        -- it (a replay of the same message returns the first row, never a second),
        -- and it is the column lookupUserMessageIdByRandomId queries to recover a
        -- minted id for the retry echo. NULL for every other kind. Added LAST so
        -- its position matches the ALTER path below on an existing journal.
        idempotency_key TEXT,
        PRIMARY KEY (conversation_id, seq)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS journal_user_once
        ON journal_event(conversation_id, message_id) WHERE kind = 'user';
      CREATE UNIQUE INDEX IF NOT EXISTS journal_placement_once
        ON journal_event(conversation_id, message_id) WHERE kind = 'placement';
    `);

    // #243 half 2a — FORWARD-MIGRATE an existing journal that predates the
    // `idempotency_key` column. `CREATE TABLE IF NOT EXISTS` above is a no-op on a
    // table that already exists, so it never adds the column; a bare unconditional
    // `ALTER TABLE … ADD COLUMN` would throw "duplicate column name" on a journal
    // this build already migrated. Gate on `table_info` so the migration is
    // idempotent both ways. Cheap (one PRAGMA at open), and needed because #271's
    // version gate does not exist yet — this is the same "schema is malleable
    // before there is a deployed install" window the DDL comment above relies on.
    //
    // ⚠️ CONSCIOUS ASSUMPTION: user rows written BEFORE this slice carry
    // `idempotency_key = NULL` (the ALTER back-fills nothing), so they are outside
    // the partial index and the check-first below cannot see them. A post-migration
    // REPLAY of such a message would miss the idempotency check and insert a SECOND
    // row — the old row keyed on the wire id (as `message_id`), the new one on the
    // server mint. That is tolerable ONLY inside this same window: there is no
    // deployed install whose journal predates the slice, and #240's destructive
    // cutover already discarded any pre-journal history, so no such old row exists
    // to double. When #271's version gate lands, this assumption is what it retires.
    const journalColumns = db
      .prepare("PRAGMA table_info(journal_event)")
      .all() as Array<{ name: string }>;
    if (!journalColumns.some((column) => column.name === "idempotency_key")) {
      db.exec("ALTER TABLE journal_event ADD COLUMN idempotency_key TEXT");
    }

    // The idempotency index MUST be created AFTER the ALTER — on a migrated
    // journal the column does not exist until the statement above runs, so
    // referencing it inside the CREATE TABLE block would fail there. Partial
    // (`WHERE kind = 'user' AND idempotency_key IS NOT NULL`) so it covers only
    // user rows and never the NULLs every other kind carries.
    //
    // UNIQUE, and it is the journal-level idempotency net that #243 half 2a needs.
    // Before this slice the durable id WAS the client wire id, so `journal_user_once`
    // (on `message_id`) made a replay collapse onto its first row. Now the id is
    // SERVER-minted per `seq`, so a replay would mint a DIFFERENT id and slip past
    // that index — the exact duplicate-row failure the mapping exists to prevent.
    // This index restores the guarantee on the STABLE key instead. `appendInboundUser`
    // checks it first inside the txn, so an ordinary replay never reaches the
    // insert; the UNIQUE clause is the belt to that check's braces (both live on
    // the same-peer-serialized flush path, so they cannot race).
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS journal_user_idempotency_once
        ON journal_event(conversation_id, idempotency_key)
        WHERE kind = 'user' AND idempotency_key IS NOT NULL;
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
    // `idempotency_key` is the trailing bind: NULL for `append` (every kind but a
    // fresh inbound user), and the stable key for `appendInboundUser`.
    const insertEvent = db.prepare(
      "INSERT INTO journal_event " +
        "(conversation_id, seq, kind, message_id, turn_id, payload, created_ms, idempotency_key) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    );
    // Two statements, one per deduped kind, with `kind` as a SQL LITERAL rather
    // than a bound parameter. A bound `kind = ?` cannot be matched against the
    // partial indexes' `WHERE kind = 'user'` / `'placement'` predicates — SQLite
    // has to prove the predicate at prepare time — so the single-statement version
    // scanned the whole conversation. EXPLAIN QUERY PLAN, re-confirmed against the
    // rowid schema:
    //   bound `kind = ?`  → SEARCH … USING INDEX sqlite_autoindex_journal_event_1
    //                       (conversation_id=?)          ← whole-conversation scan
    //   literal 'user'    → SEARCH … USING INDEX journal_user_once
    //                       (conversation_id=? AND message_id=?)
    //   literal 'placement' → … USING INDEX journal_placement_once (same shape)
    const selectExistingSeqByKind = {
      user: db.prepare(
        "SELECT seq FROM journal_event " +
          "WHERE conversation_id = ? AND kind = 'user' AND message_id = ?",
      ),
      placement: db.prepare(
        "SELECT seq FROM journal_event " +
          "WHERE conversation_id = ? AND kind = 'placement' AND message_id = ?",
      ),
    };
    const selectRows = db.prepare(
      "SELECT seq, payload, created_ms FROM journal_event " +
        "WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    );
    // #243 half 2a — served by the partial `journal_user_idempotency_once` index.
    // `kind = 'user'` is a SQL LITERAL for the same reason `selectExistingSeqByKind`
    // uses one: the partial index's predicate is provable at prepare time only
    // against a literal. Two shapes, one index: `appendInboundUser`'s check-first
    // needs the `seq` and minted `message_id`; the retry echo needs only the id.
    const selectUserByIdempotencyKey = db.prepare(
      "SELECT seq, message_id FROM journal_event " +
        "WHERE conversation_id = ? AND kind = 'user' AND idempotency_key = ?",
    );

    return {
      maintenance,
      statements: {
        selectNextSeq,
        insertEvent,
        selectExistingSeqByKind,
        selectRows,
        selectUserByIdempotencyKey,
      },
    };
  } catch (error) {
    // ⚠️ `maintenance.close()`, NOT just a rethrow. On the WAL path step 4
    // installed a `setInterval` inside this handle, and it is the ONLY thing
    // that clears it. (On a rollback-journal volume the SDK returns a no-timer
    // stub instead — `configureSqliteWalMaintenance` in `openclaw`'s
    // `src/infra/sqlite-wal.ts` — where this call is merely harmless, not
    // required. Calling it unconditionally is right for both.)
    // Everything above — the pragma, the DDL, the meta insert, all four
    // `prepare` calls — runs after that timer exists and can throw, and on
    // that path the caller never receives `maintenance`, so nothing else can
    // ever reach it. The timers are `unref()`'d and each firing throws into
    // the SDK's own swallow, so the accumulation is silent and unbounded.
    // MEASURED: five failed opens left five live `Timeout` handles; the
    // suite pins the count (`delivery-journal.test.ts`).
    maintenance.close();
    throw error;
  }
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
  const { DatabaseSync } = loadNodeSqlite();

  // 1. Owner-only (0700) directory, the same handling the credential and
  //    conversation-key stores get — including `enforceExistingMode = true`.
  //
  //    ⚠️ THE `true` IS LOAD-BEARING. `ensurePrivateDirectory` defaults it to
  //    false, which only sets 0700 on a directory it CREATES; a tuple directory
  //    already sitting at 0755 stays 0755 (measured). This file holds message
  //    plaintext, so inheriting a loose directory is not acceptable — and that
  //    is the same reason `chmodDatabaseFiles` exists one step below.
  //    Re-hardening what already exists is the whole point of both.
  //
  //    ⚠️ AND DO NOT RE-ADD A PACKAGE-WIDE CENSUS OF CALLERS HERE TO JUSTIFY IT.
  //    An earlier version of this comment argued the `true` by enumerating every
  //    other `enforceExistingMode` / `enforceDirectoryMode` caller in the package
  //    and concluding the journal would otherwise be "the only unconditional
  //    `false`". That census was written twice and was WRONG BOTH TIMES — most
  //    recently it claimed `legacy-storage-migration.ts`'s `publishCredential`
  //    never passes an unconditional `false`, while that file's own
  //    `migrateExactCredentialSource` passes exactly that, hard-coded. The
  //    argument above needs no census: it is local, it is about THIS file's
  //    contents, and it cannot be invalidated by a caller elsewhere changing.
  //    A justification that has to be re-verified across the package every time
  //    someone touches an unrelated call site is a liability, not evidence.
  ensurePrivateDirectory(dirname(databasePath), true);

  // 2. Open. SQLite creates the main file here, at 0666 & ~umask.
  const db = new DatabaseSync(databasePath);

  // Steps 3-6 and the statement preparation all run against an OPEN handle, and
  // every one of them can throw — `chmodDatabaseFiles` rethrows a non-ENOENT
  // chmod failure, the SDK helper REFUSES an unsupported filesystem outright,
  // and the DDL can fail on a corrupt file.
  //
  // A failed open leaks TWO things, and this `catch` owns only the first:
  //   - the DATABASE HANDLE and its descriptors — released here. Measured at two
  //     fds per failed open;
  //   - the SDK's periodic-CHECKPOINT TIMER, once step 4 has run — released by
  //     `openJournalConnection`'s own `catch`, because `maintenance` never
  //     reaches this scope on the failing path. Measured at one live `Timeout`
  //     per failed open.
  // Half 2 retries an open per account and per reconnect, so both accumulate.
  let connection: ReturnType<typeof openJournalConnection>;
  try {
    connection = openJournalConnection(db, databasePath);
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
  const { maintenance, statements } = connection;
  const {
    selectNextSeq,
    insertEvent,
    selectExistingSeqByKind,
    selectRows,
    selectUserByIdempotencyKey,
  } = statements;

  let closed = false;

  return {
    append(conversationId, event) {
      // ⚠️ THE EMPTY-`user`-ID REFUSAL LIVES HERE, AT THE MECHANISM, not only in
      // `journalEventForInboundUser`. That mapper guards one door; `append` is
      // public and is the other, and half 2 replaying or re-journaling a `user`
      // event it did not build through the mapper reaches this one. The failure
      // is silent and lossy: two DIFFERENT user messages under `""` collide on
      // `journal_user_once`, so the second returns `{ inserted: false }` — the
      // value this contract defines as an ordinary non-destructive retry — and
      // its text is simply absent from the only SSOT user messages have (§15.7).
      //
      // ⚠️ KIND-SPECIFIC ON PURPOSE. `placement` under `""` is FAITHFUL and is
      // pinned by its own test: the client keys progress on `id ?? ""`, so `""`
      // survives there as a real lane id, and refusing it would drop a real slot
      // claim. The client's `agent_message`/user path branches on truthiness
      // instead, so for those `""` is not an id at all. The two kinds differ
      // because the two WIRE SITES differ (reducer BOUNDARY 1) — this is not an
      // inconsistency to tidy up.
      // The `typeof` mirrors `isUsableMessageId` rather than testing `.length`
      // directly: a non-string that slipped past the type would otherwise throw
      // an unnamed `TypeError` where this raises a named one.
      if (event.kind === "user") {
        if (!(typeof event.id === "string" && event.id.length > 0)) {
          throw new Error(
            "webchannel: delivery journal refuses a `user` event with an " +
              "empty id — distinct user messages would collapse onto one row " +
              "and the second would report as an ordinary duplicate (doc §15.7)",
          );
        }
        // The LENGTH bound follows the empty-id refusal down to the mechanism
        // for the same reason: `append` is the second public door, and a
        // hand-built `user` event that never went through
        // `journalEventForInboundUser` reaches only this one. An unbounded
        // client id is amplified three times per row (payload copy, indexed
        // `message_id` copy, unique-index entry).
        //
        // USER-KIND-ONLY, exactly as the mapper's bound is: agent ids are
        // plugin-minted, and refusing an over-long one would drop DELIVERED
        // text (N10). Here that scoping is free — this branch is already gated
        // on `kind === "user"`, so the agent-id counter-argument cannot apply.
        if (event.id.length > MAX_INBOUND_USER_ID_LENGTH) {
          throw new Error(
            "webchannel: delivery journal refuses a `user` event whose id " +
              `exceeds ${MAX_INBOUND_USER_ID_LENGTH} characters (received ` +
              `${event.id.length}); see ingress-dedupe.ts's ingressDedupeKey ` +
              "for the same bound and the storage-amplification reason",
          );
        }
      }
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
          // `idempotency_key` is owned by `appendInboundUser`; every `append` kind
          // (including the egress seam's) carries none.
          null,
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
        //
        // ⚠️ GATED ON THE KINDS THAT ACTUALLY HAVE A UNIQUE INDEX. Only `user`
        // and `placement` do. For a `bubble` the lookup is not unique — it would
        // match SOME OTHER bubble carrying the same answer id (a legitimate
        // edit) and report that row's seq as `inserted: false`, which is exactly
        // the "a seq that names a different row" outcome the throw below exists
        // to prevent. Unreachable today (a `bubble` cannot conflict: the only
        // other constraint is the primary key, and `seq` was just allocated as
        // MAX+1 inside this transaction), so this is the branch that must stay
        // loud rather than clever.
        const lookup =
          kind === "user" || kind === "placement"
            ? selectExistingSeqByKind[kind]
            : undefined;
        const existing =
          lookup === undefined
            ? undefined
            : (lookup.get(conversationId, messageId) as
                | { seq: number }
                | undefined);
        if (existing === undefined) {
          throw new Error(
            "webchannel: delivery journal append conflicted on no known row " +
              `(kind ${kind})`,
          );
        }
        return { seq: Number(existing.seq), inserted: false };
      });
    },

    appendInboundUser(conversationId, input) {
      // The STABLE idempotency key is the client `random_id` when it sent one,
      // else its wire id (which the client reuses verbatim on every replay). It is
      // what makes this method idempotent even though the durable id is now
      // server-minted rather than the wire id the old `journal_user_once` net
      // keyed on.
      //
      // ⚠️ PRECONDITION — `randomId` IS CALLER-VALIDATED; THIS METHOD DOES NOT
      // RE-BOUND IT. It is stored verbatim and INDEXED (`journal_user_idempotency_once`),
      // so its length matters, but the bound lives at the caller by design (#270's
      // "bound what you index, at the door"): `ingress-dedupe.ts` passes
      // `usableId(item.message.random_id) ? item.message.random_id : undefined`,
      // i.e. a non-empty string ≤ `MAX_INGRESS_DEDUPE_ID_LENGTH` (128) or
      // `undefined`. That is exactly `ingressDedupeKey`'s keyBody rule, so
      // `randomId ?? turnId` here EQUALS the dedupe key body — but only because
      // the caller already gated it. A caller that skipped that gate would index
      // an unbounded client token; the coupling is deliberate and must stay
      // conscious. `turnId` (the wire id) is likewise the caller's gated value.
      const idempotencyKey = input.randomId ?? input.turnId;
      // The id is SERVER-MINTED, so this path does NOT run the client-supplied-id
      // validation `append` and `journalEventForInboundUser` apply — that guard
      // exists to bound HOSTILE input, and this id is our own mint
      // (`webchannel-user-<seq>`), short and always well-formed. #243 half 2a item
      // 4: the check shifts from "bound hostile input" to "trust our own mint",
      // exactly as agent ids are already unchecked. `turnId` is still the client's
      // wire id and is only ever handled structurally.
      return runSqliteImmediateTransactionSync(db, () => {
        // CHECK-FIRST, inside the txn: a replay of a message we already journaled
        // (same key) returns the FIRST row's id, never a second row. This is the
        // idempotency net #243 half 2a needs — persist-before-publish means a
        // batch can commit a row and then be refused, and the client replays it;
        // this returns the committed row instead of duplicating it. Same-peer
        // serialization plus this immediate txn make the check-then-insert atomic.
        if (idempotencyKey !== undefined) {
          const existing = selectUserByIdempotencyKey.get(
            conversationId,
            idempotencyKey,
          ) as { seq: number; message_id: string } | undefined;
          if (existing !== undefined) {
            return {
              seq: Number(existing.seq),
              inserted: false,
              messageId: existing.message_id,
            };
          }
        }
        const seq = Number(
          (selectNextSeq.get(conversationId) as { next: number }).next,
        );
        const messageId = mintServerUserMessageId(seq);
        const event: JournalEvent = {
          kind: "user",
          id: messageId,
          text: input.text,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        };
        const result = insertEvent.run(
          conversationId,
          seq,
          "user",
          messageId,
          input.turnId ?? null,
          JSON.stringify(event),
          now(),
          idempotencyKey ?? null,
        );
        // With the check above passed, a fresh `seq` yields a fresh `message_id`
        // and a fresh `idempotency_key`, so neither unique index can conflict. A
        // zero-change insert here is therefore a construction bug — fail loudly
        // rather than return a seq that names some other row.
        if (Number(result.changes) === 0) {
          throw new Error(
            "webchannel: appendInboundUser insert conflicted after an idempotency " +
              `miss (key ${String(idempotencyKey)}, id ${messageId}) — construction bug`,
          );
        }
        return { seq, inserted: true, messageId };
      });
    },

    lookupUserMessageIdByRandomId(conversationId, randomId) {
      // Queried with the client `random_id`, which is the `idempotency_key` value
      // for any row a conforming client admitted (an older client's key is its
      // wire id, and it has no random_id to look up with, so it never reaches here).
      const row = selectUserByIdempotencyKey.get(conversationId, randomId) as
        | { seq: number; message_id: string }
        | undefined;
      return row?.message_id ?? undefined;
    },

    read(conversationId, readOptions) {
      // Validate before binding. An unchecked non-integer reaches SQLite and
      // surfaces as a bare `datatype mismatch` naming nothing, and an unchecked
      // NaN binds as NULL so `seq > NULL` is never true — a SILENTLY EMPTY
      // history, which is the worse of the two by far.
      const afterSeq = requireCount(readOptions?.afterSeq ?? 0, "afterSeq", 0);
      // SQLite reads a negative LIMIT as "no limit"; that is the default here on
      // purpose — see the interface docblock.
      const limit =
        readOptions?.limit === undefined
          ? -1
          : requireCount(readOptions.limit, "limit", 1);
      const rows = selectRows.all(conversationId, afterSeq, limit) as Array<{
        seq: number;
        payload: string;
        created_ms: number;
      }>;
      return rows.map((row) => {
        // `payload` is the truth, so the whole event round-trips VERBATIM —
        // including fields and even KINDS this build does not know about. #253:
        // retain, never silently drop. That is also why `kind` is taken from
        // here and not from the column, and why the parsed value is typed
        // `RetainedJournalEvent` rather than `JournalEvent`.
        const event = JSON.parse(row.payload) as RetainedJournalEvent;
        return {
          seq: Number(row.seq),
          kind: event.kind,
          event,
          createdMs: Number(row.created_ms),
        };
      });
    },

    close() {
      if (closed) return;
      closed = true;
      // `maintenance.close()` clears the periodic-checkpoint interval the SDK
      // installed. Skipping it leaks a timer per opened journal. It swallows its
      // own checkpoint errors, so it cannot throw past here.
      maintenance.close();
      // `closeQuietly`, not `db.close()`: the handle may ALREADY be closed —
      // the SDK's transaction helper closes it itself when a ROLLBACK fails,
      // without telling this module. A bare `db.close()` would then throw out of
      // a method documented as idempotent.
      closeQuietly(db);
    },
  };
}

/**
 * Close a handle without letting the close itself mask the real error.
 *
 * Used on the failed-open path, and by `close()` — the SDK's transaction helper
 * closes `db` ITSELF when a ROLLBACK fails (`openclaw`'s
 * `src/infra/sqlite-transaction.ts`), which leaves this module's `closed` flag
 * `false` over an already-closed handle. A later `close()` would then throw out
 * of a method whose contract says it is idempotent.
 */
function closeQuietly(db: SqliteDatabase): void {
  try {
    db.close();
  } catch {
    // Already closed, or closing failed — either way there is nothing left to
    // do with this handle and nothing useful to report.
  }
}

/**
 * Owner-only mode for the main database and every sidecar that exists.
 *
 * ⚠️ WE TAKE CORE'S SUFFIX LIST, NOT CORE'S FAILURE POLICY, and the divergence
 * is deliberate. Core runs the same four suffixes through `bestEffortChmodSync`
 * (`openclaw`'s `src/state/openclaw-state-db.ts`, which is also where the
 * quoted sentence below lives) → `applyPrivateModeSync` →
 * `canIgnorePrivateChmodError` (`openclaw`'s `src/infra/private-mode.ts`),
 * which TOLERATES `ENOTSUP`/`EOPNOTSUPP`/`EINVAL` outright and `EROFS`/`EPERM`
 * conditionally (only where the target is already restrictive, or the filesystem
 * demonstrably rejects chmod), because — in its own words — "crashing at open
 * would take the gateway down on Azure Files/NFS/Docker volumes (#91919)."
 *
 * This throws on all of those instead, because `private-file.ts` in this package
 * uses a bare `chmodSync` throughout: fail-closed is the house convention here,
 * and a lone best-effort store would be the inconsistency.
 *
 * ⚠️ #287 MUST REVISIT THIS. The journal IS in the plugin's load path as of #239
 * half 2 (opened at account start), at which point core's reason starts applying
 * to us verbatim: a gateway that refuses to start on a Docker volume because a
 * `-shm` chmod returned ENOTSUP is a worse outcome than a loose `-shm`. Do not
 * treat the strictness as settled just because it survived this slice. (#280 is
 * the same seam but keeps only the residue no chmod policy covers: the SSHFS
 * hard refusal, and two comments in this file that contradict each other about
 * network filesystems.)
 *
 * #240 does not touch it either. Half 1 shipped `journal-history.ts` wired to
 * nothing; half 2 wired it up, and a READ path changes neither the load path nor
 * the chmod policy — it is `open` that runs this, once, at account start. The
 * store is now the only copy of the truth, so the decision this comment was
 * holding open is no longer "before the cutover": it is #287's, on its own.
 */
function chmodDatabaseFiles(databasePath: string): void {
  for (const suffix of SQLITE_DATABASE_FILE_SUFFIXES) {
    try {
      chmodSync(`${databasePath}${suffix}`, 0o600);
    } catch (error) {
      // A sidecar that does not exist is the normal case; anything else is a
      // real hardening failure on a file holding plaintext, and stays loud.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** A non-negative (or `min`-bounded) integer, or a throw naming the parameter. */
function requireCount(value: number, parameter: string, min: number): number {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(
      `webchannel: delivery journal read ${parameter} must be an integer ` +
        `>= ${min} (received ${String(value)})`,
    );
  }
  return value;
}

/**
 * The indexed id for an event, or `null` when the kind has none.
 *
 * `bubble` is DELIBERATELY NOT DEDUPED even though it has a message id, and the
 * asymmetry with `user`/`placement` is the point rather than an oversight: the
 * event model is last-write-wins by answer id, so a SECOND bubble for one id is
 * a legitimate EDIT of that bubble — the client's `applyBubble` upserts it in
 * place. Deduping it would silently discard the edit. (#241 turns that into a
 * typed `messageEdited` with a monotonic revision, at which point the duplicate
 * question gets a real answer instead of an omission.) `seal` needs no dedupe
 * either: the fold is keyed by answer id, so replaying one is harmless.
 *
 * ⚠️ THE `placement` DEDUPE IS NOT QUITE LOSS-FREE, so do not read the asymmetry
 * as "the deduped kinds carry nothing a repeat could update": a repeated
 * `placement` whose `turnId` DIFFERS is discarded whole, while `applyPlacement`
 * refreshes `turnId` on EVERY progress (`msg.turnId ?? prev.turnId`). Not
 * reachable today — the emitters pass a turnId that is constant for the turn,
 * and answer ids are minted monotonically so one never spans two turns — but it
 * is a real edge the day either of those changes.
 *
 * The `default` is #253's retain rule on the WRITE path: a forward event kind is
 * out of the union at RUNTIME, so it stays whole in `payload` and simply goes
 * unindexed rather than throwing.
 *
 * ⚠️ BUT IT IS AN EXHAUSTIVENESS HOLE, AND #242 FELL IN IT. This docblock used
 * to say the `default` "is NOT an exhaustiveness hole … the switch is exhaustive
 * at compile time". That is what the very next kind falsified: `reasoning` is IN
 * the union, reaches this switch through ORDINARY production egress, and —
 * because a `default` swallows what a `never` gate would have caught — was
 * written with `message_id = NULL` with nothing going red. Measured against a
 * real `openDeliveryJournal`: `seq 3 kind reasoning message_id null`.
 *
 * ⚠️ BE PRECISE ABOUT WHAT SURVIVED THAT CORRECTION. "THE WRITE PATH IS THE ONLY
 * WAY TO REACH IT" is STILL TRUE and still worth knowing — `read()` does not
 * call this function at all (it parses `payload` and takes `kind` off the parsed
 * event), so "read back from a newer build's journal" is not this branch's
 * trigger. What #242 falsified is only the clause that followed it, "which today
 * means a cast at the call site": an in-union kind with no `case` reaches the
 * `default` through an ordinary typed append, no cast required.
 *
 * ⚠️ SO DO NOT GENERALISE THIS FILE'S EXHAUSTIVENESS STORY FROM THE OTHER TWO
 * SWITCHES. `journal-history.ts`'s `KNOWN_EVENT_KINDS` and `recordFirstSeen`
 * both fail tsc on a new kind (verified: TS2741 and TS2322-to-`never`), and
 * their docblocks say so. This one cannot, because the `default` it needs for
 * #253's retain rule is the same `default` that hides a forgotten member. The
 * two requirements genuinely conflict; the only thing standing here is that a
 * new `case` must be added by hand, so ADD ONE when you grow `JournalEvent`.
 * (Splitting it — an exhaustive switch over the union plus a runtime kind test
 * in front — would restore the gate, but that is #241's typed-event work, not a
 * change to make while landing a kind.)
 */
function extractMessageId(event: JournalEvent): string | null {
  switch (event.kind) {
    case "user":
      return event.id;
    case "placement":
    case "bubble":
      return event.answerId;
    case "reasoning":
      // #242 half 1. The id is the BURST's id (the live burst's wire id, reused
      // by its `final` frame), so the column names the same message the client
      // upserted — the whole reason this column exists.
      //
      // ⚠️ INDEXING IT CANNOT COLLIDE WITH THE TWO DEDUPE INDEXES, CHECKED
      // RATHER THAN ASSUMED: `journal_user_once` and `journal_placement_once`
      // are both PARTIAL — `ON journal_event(conversation_id, message_id) WHERE
      // kind = 'user'` and `… WHERE kind = 'placement'` respectively — so a
      // `reasoning` row is outside both index predicates and can never conflict
      // with a user or placement row that happens to share an id. Reasoning is
      // therefore un-deduped, like `bubble`, which is right for the same reason:
      // a second `final` for one burst id is an EDIT the reducer upserts in
      // place, and dropping it would discard the edit.
      return event.id;
    case "seal":
      return null;
    case "tool":
      // #242 half 3 — DELIBERATELY id-less HERE, and spelled out because this is
      // the one place in that slice where a new kind is absorbed by a fallback
      // instead of failing to compile. The same diff adds a
      // `Record<JournalEvent["kind"], true>` exhaustiveness table and `never`
      // defaults elsewhere precisely so a new kind cannot slip through; a `tool`
      // row reaching `default` below would have been silent, so it gets its own
      // arm and this note.
      //
      // WHY NULL IS RIGHT, not merely tolerable. `message_id` exists to name the
      // message a row revises, for the two dedupe indexes and #240's read model.
      // A tool call is not addressed by `id` alone — its identity is the PAIR
      // `(turnId, id)` (see `durable-view-reducer.ts`'s `applyTool`), so a bare
      // `id` in this column would be a WRONG name, not a partial one: two turns
      // reusing `tool-activity-1` would file under one `message_id`. Nothing
      // reads the column for tool, and both unique indexes are PARTIAL
      // (`WHERE kind = 'user'` / `WHERE kind = 'placement'`), so a NULL here
      // collides with nothing.
      //
      // ⚠️ DO NOT "FIX" THIS BY RETURNING `event.id`. It would change the bytes
      // of every stored tool row for no reader, and it would enshrine the
      // id-alone identity that **#320** exists to replace. When tool rows need a
      // column to key on, it is the composite — a schema change, not this switch.
      return null;
    case "messageEdited":
    case "messageDeleted":
      // #241 half 1 (typed event model). Both name the TEXT message they mutate,
      // so `message_id` is that id — the column names the revised/deleted row,
      // which is the whole reason it exists. Safe against the two partial dedupe
      // indexes: `journal_user_once`/`journal_placement_once` are
      // `WHERE kind = 'user'`/`'placement'`, so a `messageEdited`/`messageDeleted`
      // row is outside both predicates and can never conflict. Added by hand
      // because this switch's `default` is #253's retain fallback, not a `never`
      // gate (see the docblock above), so a forgotten kind would silently store
      // `message_id = NULL` rather than failing to compile. Dormant in half 1: no
      // producer emits these, so no such row is written.
      return event.id;
    default:
      return null;
  }
}

/**
 * The extracted turn id. Read structurally so a forward kind still yields one.
 *
 * NOTHING INDEXES IT TODAY — there is no index on `turn_id`, and calling it
 * "extracted for indexing" would overstate it. It is a column so #240's
 * read-model queries (per-turn projection, seal reconciliation) can filter on it
 * without parsing every `payload`; the index arrives with the query that needs
 * it, not before.
 */
function extractTurnId(event: JournalEvent): string | null {
  const turnId = (event as { turnId?: unknown }).turnId;
  return typeof turnId === "string" ? turnId : null;
}
