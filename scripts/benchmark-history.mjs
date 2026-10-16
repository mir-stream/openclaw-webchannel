#!/usr/bin/env node
// Real SQLite + createHistoryServer snapshot/page path. Run under the shared lock.
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const sizes = arg('--sizes', '1000,5000,10000,20000').split(',').map(Number);
const output = resolve(arg('--output', 'docs/benchmarks/history-results.json'));
const repeats = Number(arg('--runs', '2'));
const baselineRef = arg('--baseline-ref');
const oraclePath = arg('--oracle');
const oracle = oraclePath === undefined ? undefined : await import(pathToFileURL(resolve(oraclePath)));
mkdirSync(dirname(output), { recursive: true });
const dir = mkdtempSync(resolve('.history-benchmark-'));
const bundle = join(dir, 'production.mjs');
await build({ stdin: { contents: `export { openDeliveryJournal } from './packages/plugin/src/delivery-journal.ts';\nexport { createHistoryServer } from './packages/plugin/src/history-serve.ts';\nexport { ${baselineRef ? '' : 'serveHistoryRequestStep, '}serveHistoryRequest } from './packages/plugin/src/journal-history.ts';`, resolveDir: process.cwd() }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', plugins: baselineRef === undefined ? [] : [{ name: 'frozen-git-sources', setup(builder) { builder.onLoad({ filter: /\.ts$/ }, ({ path }) => { if (path.includes('/node_modules/')) return; const relative = path.slice(process.cwd().length + 1); return { contents: execFileSync('git', ['show', `${baselineRef}:${relative}`], { encoding: 'utf8' }), loader: 'ts' }; }); } }] });
const { openDeliveryJournal, createHistoryServer, serveHistoryRequestStep, serveHistoryRequest } = await import(pathToFileURL(bundle));
const payload = 'History benchmark content. '.repeat(46);
function fixture(kind, count) {
  if (kind === 'bubbles') return Array.from({ length: count }, (_, i) => ({ kind: 'bubble', answerId: `a-${i}`, turnId: `t-${i}`, text: payload }));
  const events = [];
  for (let i = 0; events.length < count; i++) {
    const turnId = `t-${i}`, a = `a-${i}`, b = `b-${i}`;
    events.push(
      { kind: 'user', id: `u-${i}`, turnId, randomId: `random-${i}`, text: payload },
      { kind: 'placement', answerId: a, turnId },
      { kind: 'reasoning', id: `r-${i}`, turnId, text: payload },
      { kind: 'bubble', answerId: a, turnId, text: payload },
      { kind: 'tool', id: 'read', turnId, name: 'read_file', phase: 'start', argKeys: ['path', 'limit'] },
      { kind: 'placement', answerId: b, turnId },
      { kind: 'tool', id: 'read', turnId, summary: 'Found requested content', phase: 'update' },
      { kind: 'bubble', answerId: b, turnId, text: payload },
      { kind: 'tool', id: 'read', turnId, phase: 'end', status: 'completed' },
      { kind: 'approval', id: `p-${i}`, approvalKind: 'exec', title: 'Run check', prompt: 'Continue?', options: [{ decision: 'allow-once', label: 'Allow', style: 'primary' }] },
      { kind: 'approvalResolution', id: `p-${i}`, decision: 'allow-once' },
      { kind: 'seal', turnId, answers: [{ id: b, text: payload }, { id: a, text: payload }], remove: [`removed-${i}`] },
    );
  }
  return events.slice(0, count);
}
const sourceHashes = Object.fromEntries(['packages/client/src/durable-view-reducer.ts', 'packages/client/src/durable-row-versions.ts', 'packages/plugin/src/delivery-journal.ts', 'packages/plugin/src/journal-history.ts', 'packages/plugin/src/history-serve.ts', 'packages/plugin/src/materialized-history.ts'].map(file => [file, baselineRef && file.endsWith('/materialized-history.ts') ? null : createHash('sha256').update(baselineRef ? execFileSync('git', ['show', `${baselineRef}:${file}`]) : readFileSync(file)).digest('hex')]));
const results = { sourceHashes, baselineRef, oracle: oraclePath, operation: 'createHistoryServer sendSnapshot/servePage through sendHistory callback, real SQLite; setup/bundling excluded', sha: execFileSync('git', ['rev-parse', baselineRef ?? 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, platform: `${process.platform}/${process.arch}`, sizes, repeats, fixtures: [] };
try {
  for (const kind of ['bubbles', 'mixed']) for (const size of sizes) {
    const file = join(dir, `${kind}-${size}.sqlite`);
    let counts;
    const reset = () => counts = { rawEventsRead: 0, rawReadCalls: 0, materializedRowsRead: 0, materializedRowsWritten: 0, pageRowsRead: 0, cursorRowsRead: 0, identityRowsRead: 0, batches: 0, rebuilds: 0, rankRowsWritten: 0, rawEventsApplied: 0 };
    const open = () => {
      const journal = openDeliveryJournal({ databasePath: file, now: () => 1700000000000, onHistoryWork: work => {
        for (const key of Object.keys(counts)) if (typeof work[key] === 'number') counts[key] += work[key];
      } });
      const read = journal.read;
      journal.read = (...params) => { const rows = read(...params); counts.rawEventsRead += rows.length; counts.rawReadCalls++; return rows; };
      return journal;
    };
    reset();
    let journal = open();
    const events = fixture(kind, size);
    const setupAt = performance.now();
    for (const event of events) journal.append('peer', event);
    const entry = { kind, size, setupMs: performance.now() - setupAt, observations: [] };
    const request = async (scenario, run, before) => {
      reset();
      globalThis.gc?.();
      const memoryBefore = process.memoryUsage();
      const started = performance.now();
      const delay = monitorEventLoopDelay({ resolution: 1 }); delay.enable();
      let heartbeatMaxMs = 0, lastBeat = performance.now();
      const heartbeat = setInterval(() => { const at = performance.now(); heartbeatMaxMs = Math.max(heartbeatMaxMs, at - lastBeat); lastBeat = at; }, 1);
      const messages = await new Promise((resolveRequest, reject) => {
        const server = createHistoryServer({ journal, config: { limit: 50, pageSize: 50 }, logger: { error: reject }, channel: {
          sendHistory: (_peer, rows) => { resolveRequest(rows); return true; },
          sendDifference: () => true,
          effectiveOutboundLimit: () => 16 * 1024 * 1024,
          outboundWireSize: (_peer, frame) => Buffer.byteLength(JSON.stringify(frame)),
        } });
        before === undefined ? server.sendSnapshot('peer') : server.servePage('peer', { before: before.id, beforeTurnId: before.kind === 'tool' || before.kind === 'reasoning' ? before.turnId : undefined, limit: 50 });
      });
      const elapsedMs = performance.now() - started;
      heartbeatMaxMs = Math.max(heartbeatMaxMs, performance.now() - lastBeat);
      clearInterval(heartbeat); delay.disable();
      const memoryAfter = process.memoryUsage();
      entry.observations.push({ scenario, run, elapsedMs, returned: messages.length, ...counts, heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed, rssBytes: memoryAfter.rss, heartbeatMaxMs, eventLoopDelayMaxMs: delay.max / 1e6 });
      if (oracle !== undefined) {
        const oracleStarted = performance.now();
        const expected = oracle.serveHistoryRequest(journal.read, 'peer', before === undefined ? { kind: 'recent', limit: 50 } : { kind: 'page', beforeId: before.id, beforeTurnId: before.kind === 'tool' || before.kind === 'reasoning' ? before.turnId : undefined, limit: 50 });
        const oracleElapsedMs = performance.now() - oracleStarted;
        assert.deepEqual(messages, expected.messages);
        entry.observations.at(-1).oracleElapsedMs = oracleElapsedMs;
        entry.observations.at(-1).oracleEquivalent = true;
      }
      return messages;
    };
    let recent;
    for (let run = 1; run <= repeats; run++) {
      recent = await request(run === 1 ? 'cold' : 'recent', run);
      await request('unchanged', run);
      await request('page', run, recent[0]);
      await request('deep-page', run, kind === 'bubbles' ? { id: 'a-100' } : { id: 'u-20' });
      journal.close(); journal = open();
      await request('reopen', run);
      const appendAt = performance.now();
      journal.append('peer', { kind: 'bubble', answerId: `delta-${run}`, turnId: 'delta', text: payload });
      entry.observations.push({ scenario: 'append-one', run, elapsedMs: performance.now() - appendAt });
      await request('small-delta', run);
      // A metadata-only version mismatch must trigger real rebuild even through
      // a warm handle. Reset/setup time is outside the following read timing.
      const resetDb = new DatabaseSync(file);
      resetDb.prepare("INSERT INTO journal_meta(key,value) VALUES('history_materialization_version','benchmark-reset') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
      resetDb.close();
      await request('rebuild', run);
      if (!baselineRef) assert.equal(entry.observations.at(-1).rebuilds, 1);

    }
    entry.diskBytes = ['', '-wal', '-shm'].reduce((sum, suffix) => { try { return sum + statSync(file + suffix).size; } catch { return sum; } }, 0);
    journal.close();
    const finalDb = new DatabaseSync(file);
    entry.maxRankLength = baselineRef ? 0 : finalDb.prepare('SELECT MAX(length(order_key)) AS n FROM journal_history_row').get().n;
    entry.rawEvents = finalDb.prepare('SELECT COUNT(*) AS n FROM journal_event').get().n;
    entry.materializedRows = baselineRef ? 0 : finalDb.prepare('SELECT COUNT(*) AS n FROM journal_history_row').get().n;
    finalDb.close();
    results.fixtures.push(entry);
    writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify({ kind, size, setupMs: entry.setupMs, reads: entry.observations.filter(x => x.returned !== undefined).map(x => ({ scenario: x.scenario, run: x.run, ms: Math.round(x.elapsedMs * 100) / 100, raw: x.rawEventsRead, materialized: x.materializedRowsRead, returned: x.returned })) }));
  }
  const hotCount = Number(arg('--hot-inserts', baselineRef ? '0' : '600'));
  if (hotCount > 0) {
    const file = join(dir, 'hot-seals.sqlite');
    const samples = [], appendMs = [], totals = {};
    let largestRankBatch = 0;
    const journal = openDeliveryJournal({ databasePath: file, now: () => 1700000000000, onHistoryWork: work => {
      for (const [key, value] of Object.entries(work)) totals[key] = (totals[key] ?? 0) + value;
      largestRankBatch = Math.max(largestRankBatch, work.rankRowsWritten);
    } });
    for (const event of [
      { kind: 'bubble', answerId: 'left', text: 'L' },
      { kind: 'tool', id: 'between', turnId: 't', name: 'read' },
      { kind: 'bubble', answerId: 'right', text: 'R' },
      { kind: 'reasoning', id: 'tail', turnId: 't', text: 'tail' },
      { kind: 'seal', turnId: 't', answers: [], remove: ['hidden'] },
    ]) journal.append('peer', event);
    const query = async () => {
      let target;
      for (;;) {
        const step = serveHistoryRequestStep(journal, 'peer', { kind: 'recent', limit: 50 }, target);
        if (!step.pending) return step;
        target = step.targetSeq;
        await new Promise(resolveYield => setImmediate(resolveYield));
      }
    };
    await query();
    for (let i = 0; i < hotCount; i++) {
      const at = performance.now();
      journal.append('peer', { kind: 'seal', turnId: 't', answers: [{ id: 'left', text: 'L' }, { id: `insert-${i}`, text: payload }, { id: 'right', text: 'R' }], remove: ['hidden'] });
      appendMs.push(performance.now() - at);
      const readAt = performance.now();
      await query(); samples.push(performance.now() - readAt);
    }
    const final = await query();
    assert.deepEqual(final.messages, (oracle ?? { serveHistoryRequest }).serveHistoryRequest(journal.read, 'peer', { kind: 'recent', limit: 50 }).messages);
    const db = new DatabaseSync(file);
    const rankLength = db.prepare('SELECT MAX(length(order_key)) AS n FROM journal_history_row').get().n;
    db.close(); journal.close();
    const distribution = values => { const sorted = [...values].sort((a, b) => a - b); return { min: sorted[0], p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted.at(-1) }; };
    results.hotSeals = { insertions: hotCount, operation: 'serveHistoryRequestStep recent 50, scheduled yields until ready, after each dense seal', queryMs: distribution(samples), appendMs: distribution(appendMs), maxRankLength: rankLength, largestRankBatch, totals, samplesMs: samples, oracleEquivalent: true };
    writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify({ hotSeals: { ...results.hotSeals, samplesMs: undefined } }));
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(output);
