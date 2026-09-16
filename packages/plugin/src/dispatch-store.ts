import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import type { DurableEvent, RequestState } from "../../client/src/durable-view-reducer.js";

export type DispatchInput = { text: string; turnId: string; randomId?: string; retryOf?: string };
export type DispatchRow = {
  peerId: string; key: string; messageId: string; seq: number;
  input: DispatchInput; state: RequestState; owner?: string; batch?: string; stateSeq?: number;
};
export type DispatchChange = { peerId: string; id: string; turnId: string; state: RequestState; seq: number };
export type CoreDispatchBinding = { processId: string; agentId: string; sessionKey: string; storePath: string; owner: string; batch: string; peerId: string };
/** `retryOf` is the VALIDATED provenance actually stored, never the requested one. */
export type UserCommit = { messageId: string; seq: number; inserted: boolean; retryOf?: string };
export interface DispatchStore {
  bindCore(binding: CoreDispatchBinding): void;
  coreBindings(): CoreDispatchBinding[];
  retireCore(batch: string): void;
  activate(): string;
  owns(owner: string): boolean;
  accept(owner: string, peerId: string, inputs: DispatchInput[]): UserCommit[];
  lookup(peerId: string, key: string): DispatchRow | undefined;
  queued(peerId?: string, after?: number, limit?: number): DispatchRow[];
  peers(after?: string, limit?: number): string[];
  claim(owner: string, peerId: string, keys: readonly string[]): DispatchRow[];
  settle(owner: string, peerId: string, batch: string, state: "completed" | "failed" | "interrupted"): DispatchChange[];
  recoverInterrupted(owner: string): DispatchChange[];
  cancel(owner: string, peerId: string): DispatchChange[];
}

type Stored = { peer_id: string; logical_key: string; message_id: string; user_seq: number; payload: string; state: RequestState; owner: string | null; batch: string | null };
const decode = (r: Stored): DispatchRow => ({ peerId: r.peer_id, key: r.logical_key, messageId: r.message_id, seq: Number(r.user_seq), input: JSON.parse(r.payload) as DispatchInput, state: r.state, ...(r.owner ? { owner: r.owner } : {}), ...(r.batch ? { batch: r.batch } : {}) });

/** Shares the journal connection: user row, recoverable payload and status commit together. */
export function createDispatchStore(db: DatabaseSync, appendUser: (peer: string, input: DispatchInput & { requestState: RequestState }) => UserCommit, appendEvent: (peer: string, event: DurableEvent) => { seq: number }): DispatchStore {
  const version = db.prepare("SELECT value FROM journal_meta WHERE key='dispatch_schema_version'").get() as { value: string } | undefined;
  if (version && version.value !== "1") throw new Error("webchannel: unsupported dispatch schema version; use the writer version or newer");
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS journal_dispatch_core (batch TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_dispatch (
      peer_id TEXT NOT NULL, logical_key TEXT NOT NULL, message_id TEXT NOT NULL,
      user_seq INTEGER NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
      owner TEXT, batch TEXT, PRIMARY KEY(peer_id,logical_key));
      CREATE INDEX IF NOT EXISTS journal_dispatch_queue ON journal_dispatch(state,peer_id,user_seq);
      CREATE INDEX IF NOT EXISTS journal_dispatch_batch ON journal_dispatch(peer_id,owner,batch,state);`);
    db.prepare("INSERT OR IGNORE INTO journal_meta VALUES('dispatch_schema_version','1')").run();
  });
  const sql = (s: string) => db.prepare(s);
  const owns = (owner: string) => (sql("SELECT value FROM journal_meta WHERE key='dispatch_owner'").get() as { value: string } | undefined)?.value === owner;
  const checkOwner = (owner: string) => { if (!owns(owner)) throw new Error("webchannel: dispatch owner retired"); };
  const lookup = (peer: string, key: string) => {
    const row = sql("SELECT * FROM journal_dispatch WHERE peer_id=? AND logical_key=?").get(peer, key) as Stored | undefined;
    return row && decode(row);
  };
  const transition = (rows: Stored[], state: RequestState): DispatchChange[] => rows.map((row) => {
    sql("UPDATE journal_dispatch SET state=? WHERE peer_id=? AND logical_key=?").run(state, row.peer_id, row.logical_key);
    const input = JSON.parse(row.payload) as DispatchInput;
    const { seq } = appendEvent(row.peer_id, { kind: "requestState", id: row.message_id, state });
    return { peerId: row.peer_id, id: row.message_id, turnId: input.turnId, state, seq };
  });
  return {
    bindCore: binding => runSqliteImmediateTransactionSync(db, () => {
      checkOwner(binding.owner);
      const rows = sql("SELECT 1 FROM journal_dispatch WHERE peer_id=? AND owner=? AND batch=? AND state='started' LIMIT 1").get(binding.peerId, binding.owner, binding.batch);
      if (!rows) throw new Error("webchannel: core binding has no started dispatch");
      sql("INSERT INTO journal_dispatch_core VALUES(?,?) ON CONFLICT(batch) DO UPDATE SET payload=excluded.payload").run(binding.batch, JSON.stringify(binding));
    }),
    coreBindings: () => (sql("SELECT payload FROM journal_dispatch_core ORDER BY batch LIMIT 32").all() as { payload: string }[]).map(r => JSON.parse(r.payload) as CoreDispatchBinding),
    retireCore: batch => { sql("DELETE FROM journal_dispatch_core WHERE batch=?").run(batch); },
    activate: () => runSqliteImmediateTransactionSync(db, () => {
      const owner = randomUUID();
      sql("INSERT INTO journal_meta VALUES('dispatch_owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(owner);
      return owner;
    }),
    owns,
    accept: (owner, peer, inputs) => runSqliteImmediateTransactionSync(db, () => {
      checkOwner(owner);
      return inputs.map((input) => {
        const key = input.randomId ?? input.turnId;
        const existing = lookup(peer, key);
        // A retransmission echoes the provenance of the row it already has, not
        // the one it just asked for again.
        if (existing) return { messageId: existing.messageId, seq: existing.seq, inserted: false, ...(existing.input.retryOf ? { retryOf: existing.input.retryOf } : {}) };
        // Provenance can only name an interrupted request in this exact
        // conversation. An unknown or ineligible `retry_of` is DROPPED, never
        // thrown: accept() runs inside the ingress journal-append transaction,
        // so a throw would roll the whole flush batch back — no ack, no
        // rejection, co-flushed legitimate messages lost, and the client
        // retransmitting that frame until its ledger evicts it. The message is
        // an ordinary send instead, and every surface reads the stored value.
        const original = input.retryOf === undefined ? undefined
          : sql("SELECT state FROM journal_dispatch WHERE peer_id=? AND message_id=?").get(peer, input.retryOf) as { state: RequestState } | undefined;
        const accepted: DispatchInput = original?.state === "interrupted" ? input : { ...input, retryOf: undefined };
        const row = appendUser(peer, { ...accepted, requestState: "queued" });
        // An existing historical user row cannot prove it was never started.
        if (!row.inserted) return row;
        sql("INSERT INTO journal_dispatch VALUES(?,?,?,?,?,'queued',NULL,NULL)").run(peer, key, row.messageId, row.seq, JSON.stringify(accepted));
        return accepted.retryOf === undefined ? row : { ...row, retryOf: accepted.retryOf };
      });
    }),
    lookup,
    queued: (peer, after = 0, limit = 32) => (sql("SELECT * FROM journal_dispatch WHERE state='queued' AND peer_id=? AND user_seq>? ORDER BY user_seq LIMIT ?").all(peer ?? "", after, Math.min(32, limit)) as Stored[]).map(decode),
    peers: (after = "", limit = 32) => (sql("SELECT DISTINCT peer_id FROM journal_dispatch WHERE state='queued' AND peer_id>? ORDER BY peer_id LIMIT ?").all(after, Math.min(32, limit)) as { peer_id: string }[]).map(r => r.peer_id),
    claim: (owner, peer, keys) => runSqliteImmediateTransactionSync(db, () => {
      checkOwner(owner);
      const batch = randomUUID();
      const rows: DispatchRow[] = [];
      for (const key of new Set(keys)) {
        const row = lookup(peer, key);
        if (row?.state !== "queued") continue;
        const result = sql("UPDATE journal_dispatch SET state='started',owner=?,batch=? WHERE peer_id=? AND logical_key=? AND state='queued'").run(owner, batch, peer, key);
        if (Number(result.changes) !== 1) throw new Error("webchannel: dispatch claim lost");
        const { seq: stateSeq } = appendEvent(peer, { kind: "requestState", id: row.messageId, state: "started" });
        rows.push({ ...row, state: "started", owner, batch, stateSeq });
      }
      return rows.sort((a, b) => a.seq - b.seq);
    }),
    settle: (owner, peer, batch, state) => runSqliteImmediateTransactionSync(db, () => {
      checkOwner(owner);
      const changes = transition(sql("SELECT * FROM journal_dispatch WHERE peer_id=? AND owner=? AND batch=? AND state='started' ORDER BY user_seq").all(peer, owner, batch) as Stored[], state);
      if (state === "completed" || state === "failed") sql("DELETE FROM journal_dispatch_core WHERE batch=?").run(batch);
      return changes;
    }),
    recoverInterrupted: (owner) => runSqliteImmediateTransactionSync(db, () => {
      checkOwner(owner);
      return transition(sql("SELECT * FROM journal_dispatch WHERE state='started' AND owner<>? ORDER BY peer_id,user_seq LIMIT 32").all(owner) as Stored[], "interrupted");
    }),
    cancel: (owner, peer) => runSqliteImmediateTransactionSync(db, () => {
      checkOwner(owner);
      return transition(sql("SELECT * FROM journal_dispatch WHERE peer_id=? AND state IN ('queued','started') ORDER BY user_seq LIMIT 32").all(peer) as Stored[], "cancelled");
    }),
  };
}
