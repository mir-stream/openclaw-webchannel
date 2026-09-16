/**
 * Rebuildable SQLite read model. Raw journal acceptance never calls this module.
 * Each catch-up transaction commits a canonical prefix and its checkpoint together;
 * callers schedule another step between bounded transactions. There is no global
 * conversation/view cache, and an unchanged page only reads indexed page rows.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { runSqliteImmediateTransactionSync } from 'openclaw/plugin-sdk/sqlite-runtime';
import { applyDurableEventWindow, durableRowKey, type DurableWindowEntry } from '../../client/src/durable-row-versions.js';
import type { DurableMessage } from '../../client/src/durable-view-reducer.js';
import type { HistoryFetchPlan } from './history.js';
import type { RetainedJournalEvent } from './delivery-journal.js';
import { historyRowFor, isKnownJournalEvent, recordFirstSeen, type ServedHistory } from './journal-history.js';

export const HISTORY_MATERIALIZATION_VERSION = '2';
export const HISTORY_MATERIALIZATION_CHUNK_ROWS = 128;
export const HISTORY_MATERIALIZATION_SLICE_MS = 8;
export const HISTORY_RANK_MAX_LENGTH = 64;
class RankSpaceExhausted extends Error {}
export type HistoryWork = {
  rawEventsRead: number; rawReadCalls: number;
  materializedRowsRead: number; materializedRowsWritten: number;
  pageRowsRead: number; cursorRowsRead: number; identityRowsRead: number;
  batches: number; rebuilds: number; rankRowsWritten: number; rawEventsApplied: number;
};
export type HistoryPageStep =
  | { pending: true; targetSeq: number }
  | ({ pending: false; highWaterSeq: number } & ServedHistory);

type Checkpoint = {
  seq: number; valid: number; version: string; next_order: number;
  unsupported: number; last_created: number | null; ts_fallbacks: number;
  rank_phase: string | null; rank_cursor: string; rank_next: number;
};
type StoredRow = { row_key: string; order_key: string; payload: string; modification_seq: number };
type Identity = { first_ms: number | null; random_id: string | null };
const COLUMNS = {
  journal_history_checkpoint: 'conversation_id,version,seq,valid,next_order,unsupported,last_created,ts_fallbacks,rank_phase,rank_cursor,rank_next',
  journal_history_row: 'conversation_id,row_key,order_key,payload,modification_seq,id_key,cursor_turn,visible,missing_ts,next_rank',
  journal_history_identity: 'conversation_id,id_key,first_ms,random_id',
};
const TABLES = Object.keys(COLUMNS);
const INDEXES = ['journal_history_next_rank', 'journal_history_order', 'journal_history_page', 'journal_history_cursor', 'journal_history_identity_rows'];
const TRIGGERS = ['journal_history_row_insert', 'journal_history_row_update', 'journal_history_row_delete', 'journal_history_identity_insert', 'journal_history_identity_update', 'journal_history_identity_delete'];

/**
 * Lexicographic positions between adjacent ranks. New tail slots use a fixed
 * integer prefix, so ordinary appends do not lengthen every following key.
 * Fractional positions never end in zero; that leaves space before/after any
 * generated position. SQLite BINARY and JavaScript compare this ASCII alike.
 */
export function historyRankBetween(lower: string, upper?: string): string {
  if (!/^[0-9a-f]*$/.test(lower) || lower.endsWith('0') || (upper !== undefined && (!/^[0-9a-f]+$/.test(upper) || upper.endsWith('0') || lower >= upper))) throw new Error('Invalid history order interval');
  const alphabet = '0123456789abcdef';
  let prefix = '';
  for (let i = 0; ; i++) {
    const lo = i < lower.length ? alphabet.indexOf(lower[i]!) : 0;
    const hi = upper === undefined ? 16 : i < upper.length ? alphabet.indexOf(upper[i]!) : 0;
    if (lo < 0 || hi < 0 || hi < lo) throw new Error('Invalid history order interval');
    if (hi - lo > 1) {
      const rank = prefix + alphabet[Math.floor((lo + hi) / 2)];
      if (rank.length > HISTORY_RANK_MAX_LENGTH) throw new RankSpaceExhausted();
      return rank;
    }
    prefix += alphabet[lo];
    if (lo < hi) upper = undefined;
  }
}

/** Spread one event's insertions across the gap with logarithmic key growth. */
function gapRanks(lower: string, upper: string, count: number): string[] {
  if (count === 0) return [];
  const mid = Math.floor(count / 2);
  const rank = historyRankBetween(lower, upper);
  return [...gapRanks(lower, rank, mid), rank, ...gapRanks(rank, upper, count - mid - 1)];
}

export function createMaterializedHistory(db: DatabaseSync, onWork?: (work: HistoryWork) => void): {
  page(conversationId: string, plan: HistoryFetchPlan, targetSeq?: number): HistoryPageStep;
} {
  let schemaCookie = -1;
  let statements = new Map<string, StatementSync>();
  const sql = (query: string): StatementSync => {
    let statement = statements.get(query);
    if (statement === undefined) { statement = db.prepare(query); statements.set(query, statement); }
    return statement;
  };
  const ensureSchema = () => {
    const cookie = Number((db.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version);
    // journal_meta is data: changing only its version does not bump SQLite's
    // schema cookie. Check both before trusting cached prepared statements.
    const version = db.prepare("SELECT value FROM journal_meta WHERE key = 'history_materialization_version'").get() as { value: string } | undefined;
    if (cookie === schemaCookie && version?.value === HISTORY_MATERIALIZATION_VERSION) return;
    statements = new Map();
    const existing = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (?, ?, ?)").all(...TABLES);
    const validColumns = existing.length === TABLES.length && Object.entries(COLUMNS).every(([table, columns]) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name).join(',') === columns);
    const objects = [...INDEXES, ...TRIGGERS];
    const validObjects = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${objects.map(() => '?').join(',')})`).all(...objects).length === objects.length;
    if (version?.value !== HISTORY_MATERIALIZATION_VERSION || !validColumns || !validObjects) {
      // Only derived tables are replaced. Old journals need no eager replay or
      // raw schema rewrite; each peer rebuilds when history is requested.
      for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
      db.exec(`
        CREATE TABLE journal_history_checkpoint (
          conversation_id TEXT PRIMARY KEY, version TEXT NOT NULL,
          seq INTEGER NOT NULL, valid INTEGER NOT NULL, next_order INTEGER NOT NULL,
          unsupported INTEGER NOT NULL, last_created REAL, ts_fallbacks INTEGER NOT NULL,
          rank_phase TEXT, rank_cursor TEXT NOT NULL, rank_next INTEGER NOT NULL
        );
        CREATE TABLE journal_history_identity (
          conversation_id TEXT NOT NULL, id_key TEXT NOT NULL,
          first_ms REAL, random_id TEXT,
          PRIMARY KEY (conversation_id, id_key)
        );
        CREATE TABLE journal_history_row (
          conversation_id TEXT NOT NULL, row_key TEXT NOT NULL,
          order_key TEXT NOT NULL, payload TEXT NOT NULL, modification_seq INTEGER NOT NULL,
          id_key TEXT NOT NULL, cursor_turn TEXT, visible INTEGER NOT NULL, missing_ts INTEGER NOT NULL,
          next_rank TEXT,
          PRIMARY KEY (conversation_id, row_key)
        );
        CREATE INDEX journal_history_next_rank ON journal_history_row(conversation_id, next_rank) WHERE next_rank IS NOT NULL;
        CREATE INDEX journal_history_order ON journal_history_row(conversation_id, order_key);
        CREATE INDEX journal_history_page ON journal_history_row(conversation_id, visible, order_key);
        CREATE INDEX journal_history_cursor ON journal_history_row(conversation_id, id_key, visible, cursor_turn);
        CREATE INDEX journal_history_identity_rows ON journal_history_row(conversation_id, id_key, missing_ts);
        CREATE TRIGGER journal_history_row_insert AFTER INSERT ON journal_history_row BEGIN
          UPDATE journal_history_checkpoint SET valid = 0,
            ts_fallbacks = ts_fallbacks + NEW.visible * NEW.missing_ts WHERE conversation_id = NEW.conversation_id;
        END;
        CREATE TRIGGER journal_history_row_update AFTER UPDATE ON journal_history_row BEGIN
          UPDATE journal_history_checkpoint SET valid = 0,
            ts_fallbacks = ts_fallbacks + NEW.visible * NEW.missing_ts - OLD.visible * OLD.missing_ts WHERE conversation_id = NEW.conversation_id;
        END;
        CREATE TRIGGER journal_history_row_delete AFTER DELETE ON journal_history_row BEGIN
          UPDATE journal_history_checkpoint SET valid = 0,
            ts_fallbacks = ts_fallbacks - OLD.visible * OLD.missing_ts WHERE conversation_id = OLD.conversation_id;
        END;
        CREATE TRIGGER journal_history_identity_insert AFTER INSERT ON journal_history_identity BEGIN
          UPDATE journal_history_checkpoint SET valid = 0 WHERE conversation_id = NEW.conversation_id;
        END;
        CREATE TRIGGER journal_history_identity_update AFTER UPDATE ON journal_history_identity BEGIN
          UPDATE journal_history_checkpoint SET valid = 0 WHERE conversation_id = NEW.conversation_id;
        END;
        CREATE TRIGGER journal_history_identity_delete AFTER DELETE ON journal_history_identity BEGIN
          UPDATE journal_history_checkpoint SET valid = 0 WHERE conversation_id = OLD.conversation_id;
        END;
      `);
      db.prepare("INSERT INTO journal_meta(key,value) VALUES('history_materialization_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(HISTORY_MATERIALIZATION_VERSION);
    }
    schemaCookie = Number((db.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version);
  };

  return {
    page(conversationId, plan, requestedTarget) {
      const work: HistoryWork = { rawEventsRead: 0, rawReadCalls: 0, materializedRowsRead: 0, materializedRowsWritten: 0, pageRowsRead: 0, cursorRowsRead: 0, identityRowsRead: 0, batches: 0, rebuilds: 0, rankRowsWritten: 0, rawEventsApplied: 0 };
      let rankTarget = requestedTarget;
      try {
        return runSqliteImmediateTransactionSync(db, () => {
          ensureSchema();
          const maxSeq = Number((sql('SELECT COALESCE(MAX(seq),0) AS seq FROM journal_event WHERE conversation_id=?').get(conversationId) as { seq: number }).seq);
          const target = requestedTarget === undefined ? maxSeq : Math.min(requestedTarget, maxSeq);
          rankTarget = target;
          let cp = sql('SELECT * FROM journal_history_checkpoint WHERE conversation_id=?').get(conversationId) as Checkpoint | undefined;
          if (cp === undefined || cp.version !== HISTORY_MATERIALIZATION_VERSION || (cp.valid !== 1 && !(cp.valid === 2 && (cp.rank_phase === "prepare" || cp.rank_phase === "apply"))) || !Number.isSafeInteger(cp.seq) || cp.seq < 0 || cp.seq > maxSeq || !Number.isSafeInteger(cp.next_order) || cp.next_order < 0 || !Number.isSafeInteger(cp.unsupported) || cp.unsupported < 0 || !Number.isSafeInteger(cp.ts_fallbacks) || cp.ts_fallbacks < 0 || (cp.rank_phase !== null && (cp.valid !== 2 || !Number.isSafeInteger(cp.rank_next) || cp.rank_next < 0))) {
            sql('DELETE FROM journal_history_row WHERE conversation_id=?').run(conversationId);
            sql('DELETE FROM journal_history_identity WHERE conversation_id=?').run(conversationId);
            sql("INSERT OR REPLACE INTO journal_history_checkpoint VALUES(?,?,0,1,0,0,NULL,0,NULL,'',0)").run(conversationId, HISTORY_MATERIALIZATION_VERSION);
            cp = { version: HISTORY_MATERIALIZATION_VERSION, seq: 0, valid: 1, next_order: 0, unsupported: 0, last_created: null, ts_fallbacks: 0, rank_phase: null, rank_cursor: "", rank_next: 0 };
            work.rebuilds++;
          }
          const checkpoint = cp;
          if (checkpoint.rank_phase !== null) {
            // Persisted two-phase rank rebuild. No page/catch-up is exposed while
            // ranks are partly replaced. Each transaction touches <=128 ranks;
            // reopen/other handles resume the same phase without replaying raw.
            if (checkpoint.rank_phase === 'prepare') {
              const rows = sql('SELECT row_key,order_key FROM journal_history_row WHERE conversation_id=? AND order_key>? ORDER BY order_key LIMIT ?').all(conversationId, checkpoint.rank_cursor, HISTORY_MATERIALIZATION_CHUNK_ROWS) as Array<{ row_key: string; order_key: string }>;
              for (const row of rows) {
                checkpoint.rank_next++;
                sql('UPDATE journal_history_row SET next_rank=? WHERE conversation_id=? AND row_key=?').run(checkpoint.rank_next.toString(16).padStart(16, '0') + '8', conversationId, row.row_key);
                checkpoint.rank_cursor = row.order_key;
              }
              work.rankRowsWritten += rows.length;
              if (rows.length < HISTORY_MATERIALIZATION_CHUNK_ROWS) checkpoint.rank_phase = 'apply';
              sql('UPDATE journal_history_checkpoint SET valid=2,rank_phase=?,rank_cursor=?,rank_next=? WHERE conversation_id=?').run(checkpoint.rank_phase, checkpoint.rank_cursor, checkpoint.rank_next, conversationId);
            } else {
              const rows = sql('SELECT row_key,next_rank FROM journal_history_row WHERE conversation_id=? AND next_rank IS NOT NULL ORDER BY next_rank LIMIT ?').all(conversationId, HISTORY_MATERIALIZATION_CHUNK_ROWS) as Array<{ row_key: string; next_rank: string }>;
              for (const row of rows) sql('UPDATE journal_history_row SET order_key=?,next_rank=NULL WHERE conversation_id=? AND row_key=?').run(row.next_rank, conversationId, row.row_key);
              work.rankRowsWritten += rows.length;
              const finished = rows.length < HISTORY_MATERIALIZATION_CHUNK_ROWS;
              sql('UPDATE journal_history_checkpoint SET valid=?,rank_phase=?,next_order=? WHERE conversation_id=?').run(finished ? 1 : 2, finished ? null : 'apply', checkpoint.rank_next, conversationId);
            }
            return { pending: true, targetSeq: target };
          }
          const identity = (id: string): Identity | undefined => {
            const found = sql('SELECT first_ms,random_id FROM journal_history_identity WHERE conversation_id=? AND id_key=?').get(conversationId, JSON.stringify(id)) as Identity | undefined;
            if (found !== undefined) work.identityRowsRead++;
            return found;
          };
          const decode = (stored: StoredRow | undefined): DurableWindowEntry | undefined => {
            if (stored === undefined) return undefined;
            work.materializedRowsRead++;
            const row = JSON.parse(stored.payload) as DurableMessage;
            if (durableRowKey(row) !== stored.row_key) throw new Error('Invalid materialized history row identity');
            return { row, seq: Number(stored.modification_seq), order: stored.order_key };
          };
          const get = (key: string) => decode(sql('SELECT row_key,order_key,payload,modification_seq FROM journal_history_row WHERE conversation_id=? AND row_key=?').get(conversationId, key) as StoredRow | undefined);
          const neighbor = (order: string, direction: 'before' | 'after') => decode(sql(direction === 'before'
            ? 'SELECT row_key,order_key,payload,modification_seq FROM journal_history_row WHERE conversation_id=? AND order_key<? ORDER BY order_key DESC LIMIT 1'
            : 'SELECT row_key,order_key,payload,modification_seq FROM journal_history_row WHERE conversation_id=? AND order_key>? ORDER BY order_key ASC LIMIT 1').get(conversationId, order) as StoredRow | undefined);
          const last = () => decode(sql('SELECT row_key,order_key,payload,modification_seq FROM journal_history_row WHERE conversation_id=? ORDER BY order_key DESC LIMIT 1').get(conversationId) as StoredRow | undefined);
          const appendRank = () => {
            checkpoint.next_order++;
            if (!Number.isSafeInteger(checkpoint.next_order)) throw new Error('History slot counter exhausted');
            return checkpoint.next_order.toString(16).padStart(16, '0') + '8';
          };
          if (checkpoint.seq < target) {
            const rows = sql('SELECT seq,payload,created_ms FROM journal_event WHERE conversation_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?').all(conversationId, checkpoint.seq, target, HISTORY_MATERIALIZATION_CHUNK_ROWS) as Array<{ seq: number; payload: string; created_ms: number }>;
            work.rawReadCalls++;
            work.rawEventsRead += rows.length;
            if (rows.length === 0) throw new Error('History checkpoint cannot reach the requested journal prefix');
            const started = performance.now();
            for (const raw of rows) {
              const event = JSON.parse(raw.payload) as RetainedJournalEvent;
              checkpoint.last_created = Number(raw.created_ms);
              if (!isKnownJournalEvent(event)) checkpoint.unsupported++;
              else {
                recordFirstSeen({
                  has: id => identity(id)?.first_ms != null,
                  set: (id, ms) => {
                    sql('INSERT INTO journal_history_identity(conversation_id,id_key,first_ms) VALUES(?,?,?) ON CONFLICT(conversation_id,id_key) DO UPDATE SET first_ms=excluded.first_ms').run(conversationId, JSON.stringify(id), ms);
                    sql('UPDATE journal_history_row SET missing_ts=0 WHERE conversation_id=? AND id_key=? AND missing_ts=1').run(conversationId, JSON.stringify(id));
                    return;
                  },
                }, event, Number(raw.created_ms));
                if (event.kind === 'user' && event.randomId !== undefined && identity(event.id)?.random_id == null) {
                  sql('INSERT INTO journal_history_identity(conversation_id,id_key,random_id) VALUES(?,?,?) ON CONFLICT(conversation_id,id_key) DO UPDATE SET random_id=excluded.random_id').run(conversationId, JSON.stringify(event.id), JSON.stringify(event.randomId));
                }
                const { before, after, versions } = applyDurableEventWindow({ get, neighbor, last }, event, Number(raw.seq));
                const positions = new Map(before.map((entry, i) => [entry.row, i]));
                const byKey = new Map(before.map(entry => [durableRowKey(entry.row), entry]));
                let oldStart = 0, newStart = 0;
                // Unchanged object references anchor each omitted interval. The
                // canonical reducer supplies the order inside each changed run;
                // ranks only encode that order, reusing its previous slot pool.
                for (let i = 0; i <= after.length; i++) {
                  const anchor = after[i];
                  const anchorIndex = anchor === undefined ? before.length : positions.get(anchor);
                  if (anchorIndex === undefined) continue;
                  const oldRun = before.slice(oldStart, anchorIndex);
                  let lower = newStart === 0 ? '' : byKey.get(durableRowKey(after[newStart - 1]!))!.order;
                  const upper = anchor === undefined ? undefined : before[anchorIndex]!.order;
                  const extraCount = Math.max(0, i - newStart - oldRun.length);
                  const extraRanks = upper === undefined ? [] : gapRanks(oldRun.at(-1)?.order ?? lower, upper, extraCount);
                  for (let j = newStart; j < i; j++) {
                    const row = after[j]!;
                    const order = oldRun[j - newStart]?.order ?? (upper === undefined ? appendRank() : extraRanks[j - newStart - oldRun.length]!);
                    const key = durableRowKey(row), held = byKey.get(key);
                    if (held?.row !== row || held.order !== order) {
                      const visible = row.kind === 'text' && row.deleted === true ? 0 : 1;
                      sql(`INSERT INTO journal_history_row(conversation_id,row_key,order_key,payload,modification_seq,id_key,cursor_turn,visible,missing_ts) VALUES(?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(conversation_id,row_key) DO UPDATE SET order_key=excluded.order_key,payload=excluded.payload,modification_seq=excluded.modification_seq,cursor_turn=excluded.cursor_turn,visible=excluded.visible,missing_ts=excluded.missing_ts`).run(conversationId, key, order, JSON.stringify(row), versions.seq(key)!, JSON.stringify(row.id), row.kind === 'reasoning' || row.kind === 'tool' ? JSON.stringify(row.turnId) : null, visible, identity(row.id)?.first_ms == null ? 1 : 0);
                      work.materializedRowsWritten++;
                    }
                    lower = order;
                  }
                  oldStart = anchorIndex + 1;
                  newStart = i + 1;
                }
              }
              checkpoint.seq = Number(raw.seq);
              work.rawEventsApplied++;
              if (performance.now() - started >= HISTORY_MATERIALIZATION_SLICE_MS) break;
            }
            work.batches++;
            sql('UPDATE journal_history_checkpoint SET seq=?,valid=1,next_order=?,unsupported=?,last_created=? WHERE conversation_id=?').run(checkpoint.seq, checkpoint.next_order, checkpoint.unsupported, checkpoint.last_created, conversationId);
          }
          if (checkpoint.seq < target) return { pending: true, targetSeq: target };
          // All rows and metadata are read in the same SQLite snapshot as this
          // checkpoint. A second handle may have advanced beyond our target.
          const health = sql('SELECT ts_fallbacks FROM journal_history_checkpoint WHERE conversation_id=?').get(conversationId) as { ts_fallbacks: number };
          const result: HistoryPageStep = { pending: false, highWaterSeq: checkpoint.seq, messages: [], unsupportedEvents: checkpoint.unsupported, tsFallbacks: Number(health.ts_fallbacks) };
          // Preserve Array.slice semantics for direct legacy callers. Production
          // planHistoryFetch supplies bounded positive integers.
          const limit = plan.limit <= 0 ? 0 : Number.isFinite(plan.limit) ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(plan.limit)) : -1;
          if (limit === 0) return result;
          let before: string | undefined;
          if (plan.kind === 'page') {
            if (!plan.beforeId) return result;
            const matches = (plan.beforeTurnId === undefined
              ? sql('SELECT order_key FROM journal_history_row WHERE conversation_id=? AND id_key=? AND visible=1 LIMIT 2').all(conversationId, JSON.stringify(plan.beforeId))
              : sql('SELECT order_key FROM journal_history_row WHERE conversation_id=? AND id_key=? AND visible=1 AND cursor_turn=? LIMIT 2').all(conversationId, JSON.stringify(plan.beforeId), JSON.stringify(plan.beforeTurnId))) as Array<{ order_key: string }>;
            work.cursorRowsRead += matches.length;
            if (matches.length !== 1) return result;
            before = matches[0]!.order_key;
          }
          const select = `SELECT r.payload,r.modification_seq,i.first_ms,i.random_id FROM journal_history_row r
            LEFT JOIN journal_history_identity i ON i.conversation_id=r.conversation_id AND i.id_key=r.id_key
            WHERE r.conversation_id=? AND r.visible=1 ${before === undefined ? '' : 'AND r.order_key<?'} ORDER BY r.order_key DESC LIMIT ?`;
          const rows = sql(select).all(...(before === undefined ? [conversationId, limit] : [conversationId, before, limit])) as Array<{ payload: string; modification_seq: number; first_ms: number | null; random_id: string | null }>;
          work.pageRowsRead += rows.length;
          result.messages = rows.reverse().map(stored => {
            const row = JSON.parse(stored.payload) as DurableMessage;
            return { ...historyRowFor(row, stored.first_ms ?? checkpoint.last_created ?? 0), seq: Number(stored.modification_seq), ...(row.kind === 'text' && row.role === 'user' && stored.random_id != null ? { randomId: JSON.parse(stored.random_id) as string } : {}) };
          });
          return result;
        });
      } catch (error) {
        // DDL may have rolled back as well. Never reuse statements/cookie from
        // that transaction, nor turn a projection failure into empty history.
        schemaCookie = -1;
        statements = new Map();
        if (error instanceof RankSpaceExhausted) {
          // The attempted event (and any earlier work in that batch) rolled back.
          // Rebalance its last committed prefix before retrying the same event.
          runSqliteImmediateTransactionSync(db, () => {
            ensureSchema();
            sql("UPDATE journal_history_checkpoint SET valid=2,rank_phase='prepare',rank_cursor='',rank_next=0 WHERE conversation_id=? AND valid=1").run(conversationId);
          });
          return { pending: true, targetSeq: rankTarget! };
        }
        throw error;
      } finally {
        onWork?.(work);
      }
    },
  };
}
