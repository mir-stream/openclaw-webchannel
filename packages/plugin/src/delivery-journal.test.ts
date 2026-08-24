/**
 * v6 #239 — the delivery journal store.
 *
 * What these pin: the ordering and identity properties history depends on
 * (per-conversation contiguous seq, read order == append order), the idempotent
 * append the reducer's BOUNDARY 1 delegates here, and the on-disk facts that are
 * hard to notice when they regress (pragmas, file modes, WAL sidecar modes).
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DELIVERY_JOURNAL_SCHEMA_VERSION,
  openDeliveryJournal,
  type DeliveryJournal,
} from "./delivery-journal.js";
import type { JournalEvent } from "./delivery-journal-event.js";
import {
  reduceDurableView,
  type DurableEvent,
} from "../../client/src/durable-view-reducer.js";

// Same reason as `delivery-journal.ts`: a static `import ... from "node:sqlite"`
// makes vite-node fail to collect this file. See that module's comment.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const TURN = "turn-1";

const openJournals: DeliveryJournal[] = [];
const sidecars: Array<{ close(): void }> = [];
const tempRoots: string[] = [];

afterEach(() => {
  while (sidecars.length > 0) sidecars.pop()?.close();
  while (openJournals.length > 0) openJournals.pop()?.close();
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

/** A journal in its own tmpdir, inside a nested dir so 0700 creation is real. */
function newJournalPath(): string {
  const root = mkdtempSync(join(tmpdir(), "webchannel-journal-"));
  tempRoots.push(root);
  return join(root, "tuple", "delivery-journal.sqlite");
}

function open(
  databasePath: string,
  now?: () => number,
): DeliveryJournal {
  const journal = openDeliveryJournal(
    now === undefined ? { databasePath } : { databasePath, now },
  );
  openJournals.push(journal);
  return journal;
}

const bubble = (answerId: string, text: string): JournalEvent => ({
  kind: "bubble",
  answerId,
  text,
  turnId: TURN,
});

describe("seq allocation", () => {
  it("numbers each conversation contiguously from 1, interleaved", () => {
    // The §16.2-6 phantom-gap property: a DB-global AUTOINCREMENT exposed to the
    // client as its gap-sync cursor makes conversation A see holes the moment
    // conversation B writes.
    const journal = open(newJournalPath());
    const seqs: Record<string, number[]> = { a: [], b: [] };
    for (let n = 1; n <= 3; n++) {
      seqs.a.push(journal.append("conv-a", bubble(`a-${n}`, `A${n}`)).seq);
      seqs.b.push(journal.append("conv-b", bubble(`b-${n}`, `B${n}`)).seq);
    }
    expect(seqs.a).toEqual([1, 2, 3]);
    expect(seqs.b).toEqual([1, 2, 3]);
    expect(journal.read("conv-a").map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(journal.read("conv-b").map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it("reads back in append order, which is egress order", () => {
    const journal = open(newJournalPath());
    const stream: JournalEvent[] = [
      { kind: "user", id: "u-0", text: "ask", turnId: TURN },
      { kind: "placement", answerId: "a-1", turnId: TURN },
      { kind: "placement", answerId: "a-2", turnId: TURN },
      bubble("a-2", "second lane answered first"),
      bubble("a-1", "first lane"),
      {
        kind: "seal",
        turnId: TURN,
        answers: [
          { id: "a-1", text: "first lane" },
          { id: "a-2", text: "second lane answered first" },
        ],
        remove: [],
      },
    ];
    for (const event of stream) journal.append("conv", event);
    const rows = journal.read("conv");
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.map((row) => row.event)).toEqual(stream);
    expect(rows.map((row) => row.kind)).toEqual([
      "user",
      "placement",
      "placement",
      "bubble",
      "bubble",
      "seal",
    ]);
  });

  it("continues the sequence after the database is reopened", () => {
    const databasePath = newJournalPath();
    const first = open(databasePath);
    expect(first.append("conv", bubble("a-1", "one")).seq).toBe(1);
    expect(first.append("conv", bubble("a-2", "two")).seq).toBe(2);
    first.close();

    const second = open(databasePath);
    expect(second.append("conv", bubble("a-3", "three")).seq).toBe(3);
    expect(second.read("conv").map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it("honours afterSeq and limit", () => {
    const journal = open(newJournalPath());
    for (let n = 1; n <= 5; n++) journal.append("conv", bubble(`a-${n}`, `t${n}`));
    expect(journal.read("conv", { afterSeq: 2 }).map((r) => r.seq)).toEqual([
      3, 4, 5,
    ]);
    expect(journal.read("conv", { limit: 2 }).map((r) => r.seq)).toEqual([1, 2]);
    expect(
      journal.read("conv", { afterSeq: 3, limit: 1 }).map((r) => r.seq),
    ).toEqual([4]);
    expect(journal.read("other-conv")).toEqual([]);
  });

  it("refuses a non-integer or negative read window, naming the parameter", () => {
    const journal = open(newJournalPath());
    journal.append("conv", bubble("a-1", "one"));

    // A raw `datatype mismatch` from SQLite names nothing.
    expect(() => journal.read("conv", { limit: 1.5 })).toThrow(
      /delivery journal read limit must be an integer >= 1 \(received 1\.5\)/,
    );
    // Worse than an ugly error: NaN binds as NULL, `seq > NULL` is never true,
    // and the caller gets a SILENTLY EMPTY history.
    expect(() => journal.read("conv", { afterSeq: Number.NaN })).toThrow(
      /delivery journal read afterSeq must be an integer >= 0 \(received NaN\)/,
    );
    expect(() => journal.read("conv", { afterSeq: -1 })).toThrow(/afterSeq/);
    expect(() => journal.read("conv", { limit: 0 })).toThrow(/limit/);

    // The valid window still works, and the default stays unbounded.
    expect(journal.read("conv")).toHaveLength(1);
  });

  it("stamps created_ms from the injected clock", () => {
    let tick = 1_700_000_000_000;
    const journal = open(newJournalPath(), () => (tick += 1000));
    journal.append("conv", bubble("a-1", "one"));
    journal.append("conv", bubble("a-2", "two"));
    expect(journal.read("conv").map((row) => row.createdMs)).toEqual([
      1_700_000_001_000, 1_700_000_002_000,
    ]);
  });
});

describe("idempotent append", () => {
  it("writes a repeated `user` once, returning the FIRST seq and inserted:false", () => {
    // §15.8 mandates NON-DESTRUCTIVE retry of a failed append, so a retry whose
    // first attempt actually landed must not write the row twice.
    const journal = open(newJournalPath());
    const user: JournalEvent = { kind: "user", id: "u-0", text: "ask", turnId: TURN };
    journal.append("conv", bubble("a-0", "filler"));
    const first = journal.append("conv", user);
    const retry = journal.append("conv", user);

    expect(first).toEqual({ seq: 2, inserted: true });
    expect(retry).toEqual({ seq: 2, inserted: false });
    expect(journal.read("conv").filter((row) => row.kind === "user")).toHaveLength(1);
    // The retry must not burn a seq either: the next append is contiguous.
    expect(journal.append("conv", bubble("a-1", "next")).seq).toBe(3);
  });

  it("dedupes `user` per conversation, not globally", () => {
    const journal = open(newJournalPath());
    const user: JournalEvent = { kind: "user", id: "u-0", text: "ask" };
    expect(journal.append("conv-a", user)).toEqual({ seq: 1, inserted: true });
    expect(journal.append("conv-b", user)).toEqual({ seq: 1, inserted: true });
  });

  it("keeps a replayed journal REDUCIBLE — no applySeal throw (BOUNDARY 1)", () => {
    // The whole reason dedupe lives here. `applyUser` blind-appends, so a
    // duplicated user id puts two entries under one id in the view; a later
    // `seal` naming that id then finds MORE slots than answers and indexes
    // `answers[idx]` past the end. Assert the ABSENCE of that crash, not just
    // the row count.
    const journal = open(newJournalPath());
    const user: JournalEvent = { kind: "user", id: "u-0", text: "ask", turnId: TURN };
    const seal: JournalEvent = {
      kind: "seal",
      turnId: TURN,
      answers: [{ id: "u-0", text: "sealed" }],
      remove: [],
    };
    journal.append("conv", user);
    journal.append("conv", user);
    journal.append("conv", seal);

    const replayed = journal.read("conv").map((row) => row.event as DurableEvent);
    expect(replayed).toHaveLength(2);
    const view = reduceDurableView(replayed);
    expect(view.map((message) => message.id)).toEqual(["u-0"]);

    // Contrast: the SAME stream with the duplicate the journal refused is what
    // the reducer's characterization test records as throwing. Without this
    // line the assertion above could pass for the wrong reason.
    expect(() => reduceDurableView([user, user, seal] as DurableEvent[])).toThrow(
      /Cannot read properties of undefined \(reading 'id'\)/,
    );
  });

  it("writes a repeated `placement` once", () => {
    const journal = open(newJournalPath());
    const placement: JournalEvent = { kind: "placement", answerId: "a-1", turnId: TURN };
    expect(journal.append("conv", placement)).toEqual({ seq: 1, inserted: true });
    expect(journal.append("conv", placement)).toEqual({ seq: 1, inserted: false });
    expect(journal.read("conv")).toHaveLength(1);
  });

  it('dedupes a placement under the empty answerId too (it is a real id)', () => {
    const journal = open(newJournalPath());
    const placement: JournalEvent = { kind: "placement", answerId: "" };
    expect(journal.append("conv", placement).inserted).toBe(true);
    expect(journal.append("conv", placement).inserted).toBe(false);
    expect(journal.read("conv")).toHaveLength(1);
  });

  it("REFUSES a `user` event with an empty id at `append` itself", () => {
    // The mapper's throw guards one door; `append` is public and is the other,
    // and half 2 replaying a `user` event it did not build through
    // `journalEventForInboundUser` arrives here. Without this, two DIFFERENT
    // messages collapse: the second returns `{ seq: 1, inserted: false }` — the
    // "ordinary retry" value — and its text is gone from the only SSOT user
    // messages have (§15.7).
    const journal = open(newJournalPath());
    expect(() =>
      journal.append("conv", { kind: "user", id: "", text: "first" }),
    ).toThrow(/refuses a `user` event with an empty id/);
    expect(journal.read("conv")).toEqual([]);
  });

  it("still accepts a `placement` under the empty id — the kinds differ", () => {
    // Not an inconsistency to tidy: the client keys progress on `id ?? ""`, so
    // `""` is a real lane id there, while its user/agent paths branch on
    // truthiness. Refusing it would drop a real slot claim (reducer BOUNDARY 1).
    const journal = open(newJournalPath());
    expect(journal.append("conv", { kind: "placement", answerId: "" }).seq).toBe(1);
    expect(journal.read("conv")).toHaveLength(1);
  });

  it("does NOT dedupe `bubble` — a second bubble for one id is an EDIT", () => {
    // Last-write-wins by answer id: the client's `applyBubble` upserts in place,
    // so discarding the second write would discard the edit. #241 turns this
    // into a typed `messageEdited` + revision.
    const journal = open(newJournalPath());
    expect(journal.append("conv", bubble("a-1", "draft"))).toEqual({
      seq: 1,
      inserted: true,
    });
    expect(journal.append("conv", bubble("a-1", "edited"))).toEqual({
      seq: 2,
      inserted: true,
    });
    expect(journal.read("conv").map((row) => (row.event as { text: string }).text)).toEqual([
      "draft",
      "edited",
    ]);
  });

  it("does NOT dedupe `seal` — replaying one is harmless in the fold", () => {
    const journal = open(newJournalPath());
    const seal: JournalEvent = {
      kind: "seal",
      turnId: TURN,
      answers: [{ id: "a-1", text: "answer" }],
      remove: [],
    };
    journal.append("conv", seal);
    journal.append("conv", seal);
    expect(journal.read("conv")).toHaveLength(2);
  });
});

describe("transactional append", () => {
  it("leaves NO partial row when the transaction body throws", () => {
    const databasePath = newJournalPath();
    const journal = open(databasePath);
    journal.append("conv", bubble("a-1", "one"));

    // Force a real mid-transaction failure through the journal's own code path:
    // a trigger created on a SECOND connection is permanent, so the journal's
    // INSERT fires it and RAISE(ABORT) propagates out of `insertEvent.run`.
    const sidecar = new DatabaseSync(databasePath);
    sidecar.exec(
      "CREATE TRIGGER journal_event_boom AFTER INSERT ON journal_event " +
        "BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    sidecar.close();

    expect(() => journal.append("conv", bubble("a-2", "two"))).toThrow(/boom/);
    expect(journal.read("conv").map((row) => row.seq)).toEqual([1]);

    const cleanup = new DatabaseSync(databasePath);
    cleanup.exec("DROP TRIGGER journal_event_boom");
    cleanup.close();

    // The failed append burned no seq: the retry lands where it would have.
    expect(journal.append("conv", bubble("a-2", "two"))).toEqual({
      seq: 2,
      inserted: true,
    });
  });
});

describe("payload retention (#253)", () => {
  it("round-trips an unknown FIELD verbatim", () => {
    const journal = open(newJournalPath());
    const forward = {
      kind: "bubble",
      answerId: "a-1",
      text: "answer",
      turnId: TURN,
      revision: 7,
    } as unknown as JournalEvent;
    journal.append("conv", forward);
    expect(journal.read("conv")[0].event).toEqual(forward);
  });

  it("round-trips an unknown KIND verbatim rather than dropping the row", () => {
    // The store never silently drops what it does not understand — that is the
    // server destroying its own truth (reducer BOUNDARY 2's reasoning).
    const journal = open(newJournalPath());
    const forward = {
      kind: "messageDeleted",
      messageId: "a-1",
      revision: 3,
    } as unknown as JournalEvent;
    journal.append("conv", forward);
    const [row] = journal.read("conv");
    expect(row.event).toEqual(forward);
    // `kind` is read off the PAYLOAD, so a row can never report a kind its own
    // payload contradicts.
    expect(row.kind).toBe("messageDeleted");
  });

  it("leaves an unknown kind UNINDEXED without failing the append", () => {
    const databasePath = newJournalPath();
    const journal = open(databasePath);
    journal.append("conv", {
      kind: "messageDeleted",
      messageId: "a-1",
    } as unknown as JournalEvent);

    const sidecar = new DatabaseSync(databasePath);
    try {
      expect(
        sidecar
          .prepare("SELECT kind, message_id, turn_id FROM journal_event")
          .all(),
      ).toEqual([{ kind: "messageDeleted", message_id: null, turn_id: null }]);
    } finally {
      sidecar.close();
    }
  });
});

describe("connection and on-disk facts", () => {
  it("persists journal_mode=wal and seeds schema_version", () => {
    // ⚠️ `synchronous` is NOT asserted, and the omission is deliberate rather
    // than a gap. FULL is this build's DEFAULT (measured: a fresh handle reports
    // 2 before any pragma), so an assertion on it would stay green with
    // `delivery-journal.ts`'s `PRAGMA synchronous = FULL` deleted — a tautology
    // dressed as a durability guarantee. It is also per-CONNECTION state, so it
    // is unobservable from this sidecar handle at all. Both facts are recorded
    // at that exec. What IS observable is asserted here: `journal_mode` is
    // persistent in the file, and `schema_version` is a row.
    const databasePath = newJournalPath();
    open(databasePath);

    const sidecar = new DatabaseSync(databasePath);
    try {
      expect(sidecar.prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(
        sidecar
          .prepare("SELECT value FROM journal_meta WHERE key = 'schema_version'")
          .get(),
      ).toEqual({ value: DELIVERY_JOURNAL_SCHEMA_VERSION });
    } finally {
      sidecar.close();
    }
  });

  it("re-hardens a tuple directory that already existed at 0755", () => {
    // `ensurePrivateDirectory`'s default only sets 0700 on a directory it
    // CREATES, so without `enforceExistingMode = true` a pre-existing 0755
    // directory stays 0755 — and every other caller in this package already
    // passes `true`. The other mode test only ever sees a freshly created
    // directory, so it cannot catch this.
    const databasePath = newJournalPath();
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o755 });
    chmodSync(dirname(databasePath), 0o755);
    expect(mode(dirname(databasePath))).toBe(0o755);

    open(databasePath);
    expect(mode(dirname(databasePath))).toBe(0o700);
  });

  it("re-hardens sidecars an earlier build left world-readable", () => {
    // Mode inheritance only covers sidecars SQLite CREATES; it never re-chmods
    // one already on disk. So a journal whose sidecars were loosened — by a
    // crash, a restore, or a build predating this sweep — keeps them loose.
    //
    // ⚠️ THE SETUP HAS TO KEEP THE SIDECARS ALIVE, and getting that wrong makes
    // this test vacuous. MEASURED: a zero-byte `-wal` planted at 0644 is DELETED
    // AND RECREATED by SQLite on reopen, so it comes back 0600 on its own and
    // the test passes with the sweep removed. A sidecar only genuinely survives
    // while another connection holds the database open — hence `holder`.
    const databasePath = newJournalPath();
    const first = open(databasePath);
    first.append("conv", bubble("a-1", "one"));

    const holder = new DatabaseSync(databasePath);
    sidecars.push(holder);
    holder.prepare("SELECT count(*) AS n FROM journal_event").get();
    first.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      chmodSync(`${databasePath}${suffix}`, 0o644);
    }
    expect(mode(`${databasePath}-shm`)).toBe(0o644);

    open(databasePath);
    expect(mode(databasePath)).toBe(0o600);
    expect(mode(`${databasePath}-wal`)).toBe(0o600);
    // ⚠️ `-shm` IS THE ASSERTION THAT ACTUALLY CATCHES THE MISSING SWEEP.
    // MEASURED: with the sweep reduced to the main file, reopening this exact
    // state yields `main 0600, -wal 0600, -shm 0644` — SQLite rewrites the
    // `-wal` but leaves the `-shm` exactly as it found it. So the `-wal` line
    // above is a regression guard, and this one is the live defect.
    expect(mode(`${databasePath}-shm`)).toBe(0o600);
  });

  it("creates a 0700 directory, a 0600 database, and 0600 WAL sidecars", () => {
    // The sidecar assertion is the one that actually catches a late chmod:
    // SQLite copies the main file's mode onto `-wal`/`-shm` at creation, so a
    // chmod that lands after they exist leaves plaintext at 0644 while the main
    // file still looks right.
    //
    // PROVEN TO FIRE: moving `chmodSync` below the schema DDL in
    // `delivery-journal.ts` turns this red with `expected 420 to be 384`.
    // (Moving it merely below `configureSqliteConnectionPragmas` does NOT —
    // measured, the sidecars are created by the first WRITE, not by
    // `PRAGMA journal_mode = WAL`. That module's step-3 comment records it.)
    const databasePath = newJournalPath();
    const journal = open(databasePath);
    journal.append("conv", bubble("a-1", "one"));

    expect(mode(dirname(databasePath))).toBe(0o700);
    expect(mode(databasePath)).toBe(0o600);
    expect(mode(`${databasePath}-wal`)).toBe(0o600);
    expect(mode(`${databasePath}-shm`)).toBe(0o600);
  });

  it("closes idempotently", () => {
    const journal = open(newJournalPath());
    journal.append("conv", bubble("a-1", "one"));
    journal.close();
    expect(() => journal.close()).not.toThrow();
  });

  it("surfaces the REAL error when open fails, and closes the handle", () => {
    // Poison the file with a foreign `journal_event`, so the schema step's index
    // creation fails on an already-open handle — the same shape as a corrupt
    // file, a non-ENOENT chmod failure, or the SDK helper refusing the
    // filesystem.
    const databasePath = newJournalPath();
    mkdirSync(dirname(databasePath), { recursive: true });
    const seed = new DatabaseSync(databasePath);
    seed.exec("CREATE TABLE journal_event (x INTEGER)");
    seed.close();

    // The original error, not a `Cannot destructure` or a masked close failure.
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(() => openDeliveryJournal({ databasePath })).toThrow(
        /no such column: conversation_id/,
      );
    }

    // ⚠️ THE FD RELEASE ITSELF IS NOT ASSERTED HERE — counting descriptors needs
    // `/proc/self/fd`, and a Linux-only case in a portable suite is worse than
    // this one. It WAS measured: with the `try`/`catch` around the connection
    // setup removed, five failed opens leak 3,5,7,9,11 descriptors on this exact
    // fixture (two per attempt); with it, 0,0,0,0,0. Half 2 retries an open per
    // account and per reconnect, which is what makes the leak matter.
  });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}
