import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
import { openDeliveryJournal, type DeliveryJournal } from './delivery-journal.js';
import type { JournalEvent } from './delivery-journal-event.js';
import { projectJournalHistory, serveHistoryRequest, serveHistoryRequestStep } from './journal-history.js';
import { HISTORY_MATERIALIZATION_CHUNK_ROWS, HISTORY_RANK_MAX_LENGTH, type HistoryWork } from './materialized-history.js';
import type { HistoryFetchPlan } from './history.js';
import { DurableRowVersions } from '../../client/src/durable-row-versions.js';
import type { DurableView } from '../../client/src/durable-view-reducer.js';
import { createHistoryServer } from './history-serve.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'materialized-history-test-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.sqlite');
  const work: HistoryWork[] = [];
  let clock = 1000;
  const open = () => {
    const journal = openDeliveryJournal({ databasePath: path, now: () => clock++, onHistoryWork: row => work.push(row) });
    cleanup.push(() => journal.close());
    return journal;
  };
  const db = () => { const db = new DatabaseSync(path); cleanup.push(() => db.close()); return db; };
  return { open, db, work, path };
}
const all: HistoryFetchPlan = { kind: 'recent', limit: Infinity };
function page(journal: DeliveryJournal, plan: HistoryFetchPlan = all, peer = 'peer', target?: number) {
  for (let i = 0; i < 20000; i++) {
    const result = serveHistoryRequestStep(journal, peer, plan, target);
    if (!result.pending) return result;
    target = result.targetSeq;
  }
  throw new Error('history made no bounded progress');
}
function equivalent(journal: DeliveryJournal, plan: HistoryFetchPlan = all, peer = 'peer') {
  const result = page(journal, plan, peer);
  expect({ messages: result.messages, unsupportedEvents: result.unsupportedEvents, tsFallbacks: result.tsFallbacks }).toEqual(serveHistoryRequest(journal.read, peer, plan));
  expect(result.highWaterSeq).toBe(journal.maxSeq(peer));
  return result;
}
function generated(seed: number, count: number): JournalEvent[] {
  let state = seed;
  const next = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const ids = ['a', 'b', 'c', 'x:y', 'x', 'same', '\ud800', '한글', 'Case'];
  return Array.from({ length: count }, (_, i) => {
    const id = ids[next(ids.length)]!, other = ids[next(ids.length)]!;
    const turnId = ['t', 't:x', 'x:y', '\udfff'][next(4)]!;
    switch (next(12)) {
      case 0: return { kind: 'user', id, text: `user ${i}`, turnId, randomId: `random ${id}` };
      case 1: return { kind: 'placement', answerId: id, turnId };
      case 2: return { kind: 'bubble', answerId: id, text: `bubble ${i}`, turnId };
      case 3: return { kind: 'reasoning', id, turnId, text: `reason ${i}` };
      case 4: return { kind: 'tool', id, turnId, name: 'read', phase: 'start', argKeys: ['path'] };
      case 5: return { kind: 'tool', id, turnId, phase: 'end', status: 'completed', summary: `done ${i}` };
      case 6: return { kind: 'approval', id, approvalKind: 'exec', title: id, prompt: 'Allow?', options: [{ decision: 'allow-once', label: 'Allow', style: 'primary' }] };
      case 7: return { kind: 'approvalResolution', id, decision: 'allow-once' };
      case 8: return { kind: 'messageEdited', id, text: `edit ${i}`, revision: next(7), turnId };
      case 9: return { kind: 'messageDeleted', id, revision: next(7), turnId };
      case 10: return { kind: 'seal', turnId, answers: [{ id: other, text: `seal ${i}` }, { id, text: `seal ${i}` }], remove: [`absent-${i}`, id] };
      default: return { kind: 'seal', turnId, answers: [], remove: [id] };
    }
  });
}

describe('materialized history — canonical prefix and storage invariants', () => {
  it.each([1, 42, 919])('equals full replay at every generated checkpoint, including reopens and repeated application (seed %i)', seed => {
    const f = fixture(); let journal = f.open();
    const events = generated(seed, 180);
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      journal.append('peer', event);
      if (i % 11 === 0) journal.append('peer', event);
      equivalent(journal);
      if (i % 17 === 0) { journal.close(); journal = f.open(); equivalent(journal); }
    }
    let expected: DurableView = [];
    const versions = new DurableRowVersions();
    for (const raw of journal.read('peer')) expected = versions.apply(expected, raw.event as JournalEvent, raw.seq);
    const stored = f.db().prepare('SELECT payload FROM journal_history_row WHERE conversation_id=? ORDER BY order_key').all('peer') as Array<{ payload: string }>;
    expect(stored.map(row => JSON.parse(row.payload))).toEqual(JSON.parse(JSON.stringify(expected)));
    equivalent(journal);
  });

  it('retains full sparse tools, absent-removal tombstones, first-seen cross-kind timestamps, user origins and unsupported counts', () => {
    const f = fixture(), journal = f.open();
    const events: JournalEvent[] = [
      { kind: 'user', id: 'shared', text: 'user', turnId: 'wire', randomId: 'random' },
      { kind: 'tool', id: 'shared', turnId: 'one', name: 'read', argKeys: ['path'], phase: 'start' },
      { kind: 'tool', id: 'shared', turnId: 'two', name: 'write', argKeys: ['text'], phase: 'start' },
      { kind: 'seal', turnId: 'one', answers: [], remove: ['absent'] },
      { kind: 'reasoning', id: 'shared', turnId: 'one', text: 'reason' },
    ];
    for (const event of events) journal.append('peer', event);
    equivalent(journal); journal.close(); const reopened = f.open();
    reopened.append('peer', { kind: 'tool', id: 'shared', turnId: 'one', phase: 'end', status: 'completed' });
    reopened.append('peer', { kind: 'bubble', answerId: 'absent', text: 'must stay deleted' });
    reopened.append('peer', { kind: 'futureThing', value: 5 } as unknown as JournalEvent);
    const result = equivalent(reopened);
    expect(result.unsupportedEvents).toBe(1);
    expect(result.messages.filter(row => row.id === 'shared').map(row => row.ts)).toEqual([1000, 1000, 1000, 1000]);
    expect(result.messages.find(row => row.kind === 'tool' && row.turnId === 'one')).toMatchObject({ name: 'read', argKeys: ['path'], phase: 'end', status: 'completed' });
    expect(result.messages[0]).toMatchObject({ randomId: 'random', turnId: 'wire' });
    expect(result.messages.some(row => row.id === 'absent')).toBe(false);
  });

  it('uses indexed warm/deep/reopened pages and only a bounded dependency window for a small delta', () => {
    const f = fixture(); let journal = f.open();
    for (let i = 0; i < 700; i++) journal.append('peer', { kind: 'bubble', answerId: `a-${i}`, text: `${i}` });
    equivalent(journal);
    const queryPlan = f.db().prepare(`EXPLAIN QUERY PLAN SELECT r.payload,i.first_ms FROM journal_history_row r
      LEFT JOIN journal_history_identity i ON i.conversation_id=r.conversation_id AND i.id_key=r.id_key
      WHERE r.conversation_id=? AND r.visible=1 AND r.order_key<? ORDER BY r.order_key DESC LIMIT ?`).all('peer', 'ffffffffffffffff8', 50) as Array<{ detail: string }>;
    expect(queryPlan.some(row => row.detail.includes('journal_history_page'))).toBe(true);
    expect(queryPlan.some(row => row.detail.includes('TEMP B-TREE') || row.detail.startsWith('SCAN '))).toBe(false);
    for (const plan of [{ kind: 'recent', limit: 50 }, { kind: 'page', beforeId: 'a-120', limit: 50 }] as HistoryFetchPlan[]) {
      f.work.length = 0; page(journal, plan); page(journal, plan);
      expect(f.work.every(w => w.rawEventsRead === 0 && w.materializedRowsRead === 0 && w.materializedRowsWritten === 0 && w.pageRowsRead === 50 && w.cursorRowsRead <= 2)).toBe(true);
      journal.close(); journal = f.open(); f.work.length = 0; page(journal, plan);
      expect(f.work).toHaveLength(1); expect(f.work[0]).toMatchObject({ rawEventsRead: 0, materializedRowsRead: 0, materializedRowsWritten: 0, pageRowsRead: 50 });
    }
    journal.append('peer', { kind: 'bubble', answerId: 'a-100', text: 'edited' });
    f.work.length = 0; page(journal, { kind: 'recent', limit: 50 });
    expect(f.work[0]).toMatchObject({ rawEventsRead: 1, rawEventsApplied: 1, materializedRowsWritten: 1, pageRowsRead: 50 });
    expect(f.work[0]!.materializedRowsRead).toBeLessThanOrEqual(4);
    equivalent(journal);
  });

  it('preserves ambiguous/missing cursor, tool composite cursor and slice limit semantics', () => {
    const f = fixture(), journal = f.open();
    for (const event of [
      { kind: 'bubble', answerId: 'first', text: 'first' },
      { kind: 'bubble', answerId: 'shared', turnId: 'turn', text: 'answer' },
      { kind: 'tool', id: 'shared', turnId: 'turn', name: 'read' },
      { kind: 'tool', id: 'shared', turnId: 'other', name: 'read' },
      { kind: 'reasoning', id: 'r', turnId: 'turn', text: 'reason' },
      { kind: 'bubble', answerId: 'last', text: 'last' },
    ] as JournalEvent[]) journal.append('peer', event);
    for (const limit of [0, -1, 0.2, 1.2, 2, 50, NaN, Infinity, -Infinity]) {
      equivalent(journal, { kind: 'recent', limit });
      for (const beforeId of ['', 'missing', 'shared', 'last']) for (const beforeTurnId of [undefined, 'turn', 'other']) equivalent(journal, { kind: 'page', beforeId, beforeTurnId, limit });
    }
  });

  it('rolls back derived writes/checkpoint on failure; append acceptance and same-ID retry are independent', () => {
    const f = fixture(); let journal = f.open();
    journal.append('peer', { kind: 'bubble', answerId: 'a', text: 'a' }); equivalent(journal);
    const db = f.db();
    db.exec("CREATE TRIGGER inject_history_failure BEFORE INSERT ON journal_history_row WHEN json_extract(NEW.payload,'$.id')='fail' BEGIN SELECT RAISE(ABORT,'injected materialization failure'); END");
    const original = journal.appendInboundUser('peer', { text: 'user', turnId: 'wire', randomId: 'random' });
    journal.append('peer', { kind: 'bubble', answerId: 'fail', text: 'accepted' });
    expect(() => page(journal)).toThrow('injected materialization failure');
    expect(db.prepare('SELECT seq,valid FROM journal_history_checkpoint').get()).toMatchObject({ seq: 1, valid: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM journal_history_row').get()).toMatchObject({ n: 1 });
    expect(journal.appendInboundUser('peer', { text: 'retry', turnId: 'wire', randomId: 'random' })).toEqual({ ...original, inserted: false });
    journal.close(); journal = f.open();
    expect(() => page(journal)).toThrow('injected materialization failure');
    db.exec('DROP TRIGGER inject_history_failure');
    expect(equivalent(journal).messages).toHaveLength(3);
  });

  it.each(['missing-row', 'missing-checkpoint', 'wrong-version', 'ahead', 'missing-table', 'missing-index', 'wrong-columns'])('rebuilds %s derived state while preserving raw events', mode => {
    const f = fixture(), journal = f.open();
    for (const event of generated(56, 60)) journal.append('peer', event);
    equivalent(journal); const raw = journal.read('peer'); const db = f.db();
    if (mode === 'missing-row') db.exec("DELETE FROM journal_history_row WHERE row_key=(SELECT row_key FROM journal_history_row LIMIT 1)");
    if (mode === 'missing-checkpoint') db.exec('DELETE FROM journal_history_checkpoint');
    if (mode === 'wrong-version') db.exec("UPDATE journal_meta SET value='old' WHERE key='history_materialization_version'");
    if (mode === 'ahead') db.exec('UPDATE journal_history_checkpoint SET seq=100000');
    if (mode === 'missing-table') db.exec('DROP TABLE journal_history_identity');
    if (mode === 'missing-index') db.exec('DROP INDEX journal_history_page');
    if (mode === 'wrong-columns') db.exec('ALTER TABLE journal_history_identity RENAME COLUMN first_ms TO incompatible');
    f.work.length = 0;
    equivalent(journal); expect(journal.read('peer')).toEqual(raw);
    expect(f.work.reduce((sum, w) => sum + w.rebuilds, 0)).toBeGreaterThan(0);
    expect(f.work.reduce((sum, w) => sum + w.rawEventsApplied, 0)).toBe(raw.length);
    expect(db.prepare("SELECT value FROM journal_meta WHERE key='history_materialization_version'").get()).toMatchObject({ value: '1' });
    expect(db.prepare('SELECT valid,version,seq FROM journal_history_checkpoint').get()).toMatchObject({ valid: 1, version: '1', seq: journal.maxSeq('peer') });
  });

  it('upgrades a legacy raw-journal fixture lazily without a startup projection', () => {
    const f = fixture(); const db = f.db();
    db.exec("CREATE TABLE journal_event(conversation_id TEXT,seq INTEGER,kind TEXT,message_id TEXT,turn_id TEXT,payload TEXT,created_ms INTEGER,PRIMARY KEY(conversation_id,seq))");
    db.prepare('INSERT INTO journal_event VALUES(?,?,?,?,?,?,?)').run('peer', 1, 'bubble', 'old', null, JSON.stringify({ kind: 'bubble', answerId: 'old', text: 'legacy' }), 123);
    const journal = f.open();
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='journal_history_row'").get()).toBeUndefined();
    expect(equivalent(journal).messages).toEqual([{ id: 'old', role: 'agent', text: 'legacy', ts: 123, seq: 1 }]);
  });

  it('shares coherent committed prefixes across handles and keeps closed/account/peer state isolated', () => {
    const f = fixture(), a = f.open(), b = f.open();
    for (let i = 0; i < 400; i++) a.append('peer', { kind: 'bubble', answerId: `a-${i}`, text: `${i}` });
    const older = serveHistoryRequestStep(a, 'peer', { kind: 'recent', limit: 50 });
    expect(older.pending).toBe(true);
    a.append('peer', { kind: 'bubble', answerId: 'later', text: 'later' });
    equivalent(b);
    const result = page(a, { kind: 'recent', limit: 50 }, 'peer', 400);
    expect(result.highWaterSeq).toBe(401); expect(result.messages.at(-1)?.id).toBe('later');
    b.append('Peer', { kind: 'bubble', answerId: 'separate', text: 'case preserving' });
    expect(equivalent(a, all, 'Peer').messages.map(row => row.id)).toEqual(['separate']);
    const account = fixture().open(); account.append('peer', { kind: 'bubble', answerId: 'account', text: 'own account' });
    expect(equivalent(account).messages.map(row => row.id)).toEqual(['account']);
    a.close(); expect(() => page(a)).toThrow('closed'); equivalent(b);
  });

  it('publishes the materialized checkpoint high-water when another handle overtakes a deferred snapshot', () => {
    const f = fixture(), a = f.open(), b = f.open();
    for (let i = 0; i < 400; i++) a.append('peer', { kind: 'bubble', answerId: `a-${i}`, text: `${i}` });
    const queue: Array<() => void> = [], sent: unknown[] = [];
    const server = createHistoryServer({ journal: a, config: { limit: 50, pageSize: 50 }, schedule: fn => { queue.push(fn); }, channel: {
      sendHistory: (_peer, rows, highWaterSeq) => { sent.push({ rows, highWaterSeq }); return true; }, sendDifference: () => true, effectiveOutboundLimit: () => 1000000, outboundWireSize: () => 100,
    } });
    server.sendSnapshot('peer'); queue.shift()!(); expect(sent).toEqual([]);
    b.append('peer', { kind: 'bubble', answerId: 'later', text: 'later' }); page(b);
    // Any extra MAX sample would falsely claim an event absent from the rows.
    a.maxSeq = () => 99999;
    while (queue.length) queue.shift()!();
    expect(sent).toMatchObject([{ highWaterSeq: 401, rows: expect.arrayContaining([expect.objectContaining({ id: 'later' })]) }]);
  });

  it('bounds hot seal insertion ranks with cooperative resumable rebuilding, sparse anchors and tombstones', () => {
    const f = fixture(); let journal = f.open(); const db = f.db();
    for (const event of [
      { kind: 'bubble', answerId: 'left', text: 'L' },
      { kind: 'tool', id: 'tool', turnId: 't', name: 'read' },
      { kind: 'bubble', answerId: 'right', text: 'R' },
      { kind: 'reasoning', id: 'tail', turnId: 't', text: 'tail' },
      { kind: 'seal', turnId: 't', answers: [], remove: ['hidden'] },
    ] as JournalEvent[]) journal.append('peer', event);
    equivalent(journal);
    let reopenedDuringRank = false, failedDuringRank = false;
    for (let i = 0; i < 420; i++) {
      journal.append('peer', { kind: 'seal', turnId: 't', answers: [{ id: 'left', text: 'L' }, { id: `insert-${i}`, text: `${i}` }, { id: 'right', text: 'R' }], remove: ['hidden'] });
      let target: number | undefined;
      for (let step = 0; step < 1000; step++) {
        const result = serveHistoryRequestStep(journal, 'peer', all, target);
        if (!result.pending) break;
        target = result.targetSeq;
        const checkpoint = db.prepare('SELECT * FROM journal_history_checkpoint').get();
        if (checkpoint?.rank_phase != null && !reopenedDuringRank) {
          journal.close(); journal = f.open(); reopenedDuringRank = true;
        }
        if (checkpoint?.rank_phase === 'apply' && !failedDuringRank) {
          db.exec("CREATE TRIGGER fail_rank BEFORE UPDATE OF order_key ON journal_history_row BEGIN SELECT RAISE(ABORT,'injected rank failure'); END");
          expect(() => serveHistoryRequestStep(journal, 'peer', all, target)).toThrow('injected rank failure');
          expect(db.prepare('SELECT * FROM journal_history_checkpoint').get()).toEqual(checkpoint);
          db.exec('DROP TRIGGER fail_rank'); failedDuringRank = true;
        }
      }
      equivalent(journal);
      if (i % 31 === 0) { journal.close(); journal = f.open(); }
      const max = db.prepare('SELECT MAX(length(order_key)) AS n FROM journal_history_row').get() as { n: number };
      expect(max.n).toBeLessThanOrEqual(HISTORY_RANK_MAX_LENGTH);
    }
    expect(reopenedDuringRank).toBe(true);
    expect(failedDuringRank).toBe(true);
    expect(f.work.some(w => w.rankRowsWritten > 0)).toBe(true);
    expect(f.work.every(w => w.rankRowsWritten <= HISTORY_MATERIALIZATION_CHUNK_ROWS)).toBe(true);
    expect(page(journal).messages.some(row => row.id === 'hidden')).toBe(false);
    expect(projectJournalHistory(journal.read, 'peer').messages).toEqual(page(journal).messages);
  }, 30000);
});
