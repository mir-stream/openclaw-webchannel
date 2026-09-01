/**
 * v6 #239 — the delivery journal store.
 *
 * What these pin: the ordering and identity properties history depends on
 * (per-conversation contiguous seq, read order == append order), the idempotent
 * append the reducer's BOUNDARY 1 delegates here, and the on-disk facts that are
 * hard to notice when they regress (pragmas, file modes, WAL sidecar modes).
 */
import { createHook } from "node:async_hooks";
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

  it("REFUSES a `user` event whose id exceeds the 128-char bound", () => {
    // The bound follows the empty-id refusal down to the mechanism: `append` is
    // the second public door, and a hand-built event never passes the mapper.
    const journal = open(newJournalPath());
    expect(() =>
      journal.append("conv", {
        kind: "user",
        id: "z".repeat(1_000_000),
        text: "hi",
      }),
    ).toThrow(/exceeds 128 characters \(received 1000000\)/);
    expect(journal.read("conv")).toEqual([]);
    // Exactly at the bound is accepted.
    expect(
      journal.append("conv", { kind: "user", id: "z".repeat(128), text: "hi" })
        .seq,
    ).toBe(1);
  });

  it("does NOT length-bound a `bubble` — agent ids are ours (N10)", () => {
    // The guard is gated on `kind === "user"`, so the agent-id counter-argument
    // that kept the bound out of the shared predicate cannot apply here.
    const journal = open(newJournalPath());
    const longAgentId = "a".repeat(1_000);
    expect(journal.append("conv", bubble(longAgentId, "delivered")).seq).toBe(1);
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
    //
    // ⚠️ THE STAND-IN KIND MUST BE OUTSIDE THE UNION, and this one changed: it
    // was `messageDeleted`, which #241 half 1 promoted to a REAL member — so it
    // stopped being an "unknown kind" and started hitting `extractMessageId`'s
    // typed arm. `unknownFutureKind` is a kind only a NEWER build could write;
    // if a later slice ever adds it, pick another out-of-union name here.
    const journal = open(newJournalPath());
    const forward = {
      kind: "unknownFutureKind",
      messageId: "a-1",
      revision: 3,
    } as unknown as JournalEvent;
    journal.append("conv", forward);
    const [row] = journal.read("conv");
    expect(row.event).toEqual(forward);
    // `kind` is read off the PAYLOAD, so a row can never report a kind its own
    // payload contradicts.
    expect(row.kind).toBe("unknownFutureKind");
  });

  it("extracts turn_id for known AND unknown kinds, and leaves an unknown kind UNINDEXED", () => {
    // ⚠️ THE `turn_id` ASSERTIONS ARE LOAD-BEARING AND WERE ADDED LATE. Before
    // them, `extractTurnId` had NO coverage at all: replacing its whole body
    // with `return null` kept every test in both new files green, because the
    // only other place `turn_id` is read is this query and it expected `null`,
    // while every round-trip assertion reads `turnId` out of the PAYLOAD and so
    // cannot see the column. #240 filters per-turn queries on this column
    // (`delivery-journal.ts`'s `extractTurnId` docblock), and would have
    // inherited a silently all-NULL column with nothing going red.
    //
    // The unknown-kind row carries a turnId on purpose: it is what pins the
    // "read STRUCTURALLY so a forward kind still yields one" half of that
    // docblock, which a known-kind row alone cannot reach.
    const databasePath = newJournalPath();
    const journal = open(databasePath);
    journal.append("conv", bubble("a-1", "one"));
    // `unknownFutureKind` — a kind only a newer build could write. Was
    // `messageDeleted` until #241 half 1 made that a real, INDEXED member; the
    // stand-in must stay outside the union to exercise the retain-unindexed path.
    journal.append("conv", {
      kind: "unknownFutureKind",
      messageId: "a-2",
      turnId: TURN,
    } as unknown as JournalEvent);

    const sidecar = new DatabaseSync(databasePath);
    try {
      expect(
        sidecar
          .prepare("SELECT kind, message_id, turn_id FROM journal_event")
          .all(),
      ).toEqual([
        { kind: "bubble", message_id: "a-1", turn_id: TURN },
        // `message_id` NULL: the unknown kind goes unindexed rather than
        // failing the append. `turn_id` still populated: extracted structurally.
        { kind: "unknownFutureKind", message_id: null, turn_id: TURN },
      ]);
    } finally {
      sidecar.close();
    }
  });

  it("indexes a reasoning row's message_id as the BURST id, never NULL (#242 half 1)", () => {
    // ⚠️ THIS IS A REGRESSION GUARD FOR A REAL DEFECT, NOT COVERAGE FOR ITS OWN
    // SAKE. `extractMessageId` needs its `default` (#253's retain rule for a
    // forward kind), and that same `default` swallows a member of `JournalEvent`
    // whose `case` someone forgot — no `never` gate can fire behind it. #242
    // half 1 walked straight into that: `reasoning` rows shipped with
    // `message_id = NULL` and nothing anywhere went red. The two sibling
    // switches in `journal-history.ts` DO fail tsc on a new kind; this one
    // structurally cannot, so the check has to be a test.
    const databasePath = newJournalPath();
    const journal = open(databasePath);
    journal.append("conv", {
      kind: "reasoning",
      id: "r-1",
      turnId: TURN,
      text: "the whole thought",
    });

    const sidecar = new DatabaseSync(databasePath);
    try {
      expect(
        sidecar
          .prepare("SELECT kind, message_id, turn_id FROM journal_event")
          .all(),
      ).toEqual([{ kind: "reasoning", message_id: "r-1", turn_id: TURN }]);
    } finally {
      sidecar.close();
    }
  });

  it("does not dedupe reasoning, and cannot collide with the two kind-scoped indexes", () => {
    // `journal_user_once` and `journal_placement_once` are PARTIAL —
    // `WHERE kind = 'user'` and `WHERE kind = 'placement'` — so a reasoning row
    // is outside both index predicates however its id is shaped. Asserted rather
    // than read off the schema, because indexing `message_id` for a new kind is
    // exactly where a partial index stops being partial by accident.
    //
    // Un-deduped is also the RIGHT rule, for `bubble`'s reason: a second `final`
    // frame under one burst id is an EDIT the reducer upserts in place, and
    // dropping it would discard the edit.
    const journal = open(newJournalPath());
    expect(journal.append("conv", { kind: "user", id: "X", text: "hi" }).inserted).toBe(true);
    expect(
      journal.append("conv", { kind: "placement", answerId: "X", turnId: TURN }).inserted,
    ).toBe(true);
    expect(
      journal.append("conv", { kind: "reasoning", id: "X", turnId: TURN, text: "one" }).inserted,
    ).toBe(true);
    expect(
      journal.append("conv", { kind: "reasoning", id: "X", turnId: TURN, text: "two" }).inserted,
    ).toBe(true);
    expect(journal.read("conv").map((row) => row.event)).toEqual([
      { kind: "user", id: "X", text: "hi" },
      { kind: "placement", answerId: "X", turnId: TURN },
      { kind: "reasoning", id: "X", turnId: TURN, text: "one" },
      { kind: "reasoning", id: "X", turnId: TURN, text: "two" },
    ]);
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
    // This pins the END STATE — every file this journal creates ends at 0600.
    //
    // ⚠️ IT DOES NOT PIN THE CHMOD'S POSITION, and an earlier version of this
    // comment claimed it did ("PROVEN TO FIRE: moving `chmodSync` below the
    // schema DDL turns this red with `expected 420 to be 384`"). That was true
    // when the sweep covered only the MAIN file. It stopped being true in this
    // same PR, when the sweep grew to `SQLITE_DATABASE_FILE_SUFFIXES` — it now
    // chmods `-wal`/`-shm` explicitly, so running it AFTER the DDL finds the
    // sidecars already on disk and hardens them anyway. RE-MEASURED both
    // orderings: the final modes are `main 0600, -wal 0600, -shm 0600` either
    // way, so the claimed-red mutation is green. A rationale that outlived its
    // code.
    //
    // What the early position actually buys is the absence of a WINDOW in which
    // `-wal`/`-shm` exist at 0644 while another process could open them, and
    // NOTHING pins that — a single-process end-state assertion structurally
    // cannot. The position is still correct (it is the earliest correct point);
    // it is simply unguarded, and this comment no longer says otherwise.
    //
    // The sweep ITSELF is pinned, by the sibling test above: reducing it to the
    // main file leaves a pre-existing `-shm` at 0644 and turns that one red.
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

  it("surfaces the REAL error when open fails, and leaks no checkpoint timer", async () => {
    // Poison the file with a foreign `journal_event`, so the schema step's index
    // creation fails on an already-open handle — the same shape as a corrupt
    // file, a non-ENOENT chmod failure, or the SDK helper refusing the
    // filesystem. Crucially it fails AFTER step 4, which is what makes the SDK's
    // periodic-checkpoint `setInterval` already exist.
    const databasePath = newJournalPath();
    mkdirSync(dirname(databasePath), { recursive: true });
    const seed = new DatabaseSync(databasePath);
    seed.exec("CREATE TABLE journal_event (x INTEGER)");
    seed.close();

    // `async_hooks` is a portable builtin, unlike the `/proc/self/fd` counting
    // the descriptor half of this leak would need — so this is the half that can
    // be pinned, and the two share one root cause and one fix.
    //
    // ⚠️ TWO THINGS MAKE THE NAIVE VERSION OF THIS TEST USELESS, both measured:
    //  - a GLOBAL live-Timeout count is polluted by vitest's own timers (it
    //    drifts 1→3→2→3 on its own), so only ids created INSIDE the call being
    //    tested may be counted — hence `capturing`;
    //  - `destroy` does NOT fire synchronously on `clearInterval`, so a
    //    same-tick assertion sees a correctly-cleared timer as still live. One
    //    `setImmediate` is enough to flush it: in a control with one cleared and
    //    one deliberately-leaked interval, exactly the cleared one reported
    //    `destroy` after the flush.
    const created: number[] = [];
    const destroyed = new Set<number>();
    let capturing = false;
    const hook = createHook({
      init: (asyncId, type) => {
        if (capturing && type === "Timeout") created.push(asyncId);
      },
      destroy: (asyncId) => destroyed.add(asyncId),
    });
    hook.enable();
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        capturing = true;
        // The original error, not a `Cannot destructure` or a masked close
        // failure. Repeated because the leak is per-attempt: one iteration
        // cannot tell "released" from "accumulating".
        expect(() => openDeliveryJournal({ databasePath })).toThrow(
          /no such column: conversation_id/,
        );
        capturing = false;
      }
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      hook.disable();
    }

    // Step 4 installs the SDK's periodic-checkpoint `setInterval` before the
    // step that throws here, so a failed open creates one. It is `unref()`'d and
    // each firing throws into the SDK's own swallow, which makes an accumulation
    // completely silent — nothing but this can see it.
    expect(created.length).toBe(5);
    expect(created.filter((asyncId) => !destroyed.has(asyncId))).toEqual([]);

    // ⚠️ THE DESCRIPTOR HALF IS STILL NOT ASSERTED — that needs `/proc/self/fd`,
    // and a Linux-only case in a portable suite is worse than this note. It WAS
    // measured on this same fixture: with `openDeliveryJournal`'s `try`/`catch`
    // removed, five failed opens leak 3,5,7,9,11 descriptors (two per attempt);
    // with it, 0,0,0,0,0.
  });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("#243 half 2a — appendInboundUser (server-assigned id) + idempotency", () => {
  it("mints webchannel-user-<seq>, journals under it, keeps turnId as the wire id", () => {
    const journal = open(newJournalPath());
    const first = journal.appendInboundUser("conv", { text: "hi", turnId: "wire-1", randomId: "r-1" });
    const second = journal.appendInboundUser("conv", { text: "yo", turnId: "wire-2", randomId: "r-2" });

    expect(first).toEqual({ seq: 1, inserted: true, messageId: "webchannel-user-1" });
    expect(second).toEqual({ seq: 2, inserted: true, messageId: "webchannel-user-2" });
    // The durable row's id is the server mint; turnId is the wire id; the client
    // random_id is NOT in the reducer-visible event (it lives only in the column).
    expect(journal.read("conv").map((row) => row.event)).toEqual([
      { kind: "user", id: "webchannel-user-1", text: "hi", turnId: "wire-1" },
      { kind: "user", id: "webchannel-user-2", text: "yo", turnId: "wire-2" },
    ]);
  });

  it("never mints an id that could collide with an agent (nextMessageId) id", () => {
    // Agent ids are `webchannel-<digits>-<6 chars>`; a server user id is
    // `webchannel-user-<seq>`. The `user-` infix is the collision guard.
    const journal = open(newJournalPath());
    const { messageId } = journal.appendInboundUser("conv", { text: "hi", turnId: "w", randomId: "r" });
    expect(messageId).toMatch(/^webchannel-user-\d+$/);
    // The agent-id shape has DIGITS right after `webchannel-`; this never does.
    expect(messageId).not.toMatch(/^webchannel-\d/);
  });

  it("is idempotent on the random_id — a replay returns the first id and writes no second row", () => {
    const journal = open(newJournalPath());
    const first = journal.appendInboundUser("conv", { text: "hi", turnId: "wire-1", randomId: "r-1" });
    const replay = journal.appendInboundUser("conv", { text: "hi", turnId: "wire-1", randomId: "r-1" });

    expect(replay).toEqual({ seq: 1, inserted: false, messageId: first.messageId });
    expect(journal.read("conv").map((row) => row.seq)).toEqual([1]);
  });

  it("is idempotent on the wire id when the client sent no random_id", () => {
    const journal = open(newJournalPath());
    const first = journal.appendInboundUser("conv", { text: "hi", turnId: "wire-1" });
    const replay = journal.appendInboundUser("conv", { text: "hi", turnId: "wire-1" });

    expect(replay).toEqual({ seq: 1, inserted: false, messageId: first.messageId });
    expect(journal.read("conv").map((row) => row.seq)).toEqual([1]);
  });

  it("lookupUserMessageIdByRandomId recovers the minted id, and is undefined for the unknown", () => {
    const journal = open(newJournalPath());
    const { messageId } = journal.appendInboundUser("conv", { text: "hi", turnId: "wire-1", randomId: "r-1" });

    expect(journal.lookupUserMessageIdByRandomId("conv", "r-1")).toBe(messageId);
    expect(journal.lookupUserMessageIdByRandomId("conv", "nope")).toBeUndefined();
    // Scoped per conversation — the same random_id in another conversation misses.
    expect(journal.lookupUserMessageIdByRandomId("other", "r-1")).toBeUndefined();
    // An older-client row keyed on its wire id is not addressable by a random_id.
    journal.appendInboundUser("conv", { text: "old", turnId: "wire-2" });
    expect(journal.lookupUserMessageIdByRandomId("conv", "wire-2")).toBe("webchannel-user-2");
  });

  it("forward-migrates a journal whose journal_event predates the idempotency_key column", () => {
    // Simulate an on-disk journal written by a build before this slice: the
    // journal_event table exists WITHOUT idempotency_key. Opening it must ALTER
    // the column in and then function normally, not throw.
    const path = newJournalPath();
    mkdirSync(dirname(path), { recursive: true });
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE journal_event (
        conversation_id TEXT    NOT NULL,
        seq             INTEGER NOT NULL,
        kind            TEXT    NOT NULL,
        message_id      TEXT,
        turn_id         TEXT,
        payload         TEXT    NOT NULL,
        created_ms      INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, seq)
      );
    `);
    legacy.close();

    const journal = open(path);
    const first = journal.appendInboundUser("conv", { text: "hi", turnId: "wire-1", randomId: "r-1" });
    expect(first.messageId).toBe("webchannel-user-1");
    // Idempotency (which needs the migrated column and its index) still holds.
    expect(
      journal.appendInboundUser("conv", { text: "hi", turnId: "wire-1", randomId: "r-1" }),
    ).toEqual({ seq: 1, inserted: false, messageId: "webchannel-user-1" });
    expect(journal.lookupUserMessageIdByRandomId("conv", "r-1")).toBe("webchannel-user-1");
  });
});
