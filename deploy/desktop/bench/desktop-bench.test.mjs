// node --test deploy/desktop/bench/desktop-bench.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregate,
  classify,
  folderBytes,
  insertBatches,
  parseOptions,
  parseProcStatus,
  parseSmapsRollup,
  renderMarkdown,
  runOrder,
  summarizeSamples,
} from './desktop-bench-lib.mjs';

test('runOrder alternates which stack goes first on every repetition', () => {
  assert.deepEqual(runOrder(0, ['ts', 'go']), ['ts', 'go']);
  assert.deepEqual(runOrder(1, ['ts', 'go']), ['go', 'ts']);
  assert.deepEqual(runOrder(2, ['ts', 'go']), ['ts', 'go']);
});

test('parseOptions reads defaults and refuses bad values', () => {
  const o = parseOptions([]);
  assert.deepEqual(o.sizes, [1, 10]);
  assert.equal(o.reps, 3);
  assert.deepEqual(o.steps, [1, 4, 8]);
  assert.equal(o.stepSeconds, 10);
  assert.equal(o.writes, 40);
  assert.deepEqual(o.stacks, ['ts', 'go']);
  const custom = parseOptions(['--sizes', '1', '--reps', '1', '--stacks', 'go', '--steps', '2']);
  assert.deepEqual(custom.sizes, [1]);
  assert.deepEqual(custom.stacks, ['go']);
  assert.deepEqual(custom.steps, [2]);
  assert.throws(() => parseOptions(['--reps', '0']), /--reps/);
  assert.throws(() => parseOptions(['--stacks', 'rust']), /--stacks/);
  assert.throws(() => parseOptions(['--sizes', '1.5']), /--sizes/);
  assert.throws(() => parseOptions(['--steps', '0']), /--steps/);
  assert.throws(() => parseOptions(['--step-seconds', '500']), /--step-seconds/);
  // `pnpm run x -- --flag` forwards the separator itself.
  assert.deepEqual(parseOptions(['--', '--reps', '2']).reps, 2);
});

test('parseSmapsRollup and parseProcStatus read kB values', () => {
  const rollup = 'Rss:              120 kB\nPss:               80 kB\nShared_Clean: 10 kB\n';
  assert.deepEqual(parseSmapsRollup(rollup), { rssKb: 120, pssKb: 80 });
  const status = 'Name:\tpostgres\nPPid:\t7\nVmHWM:\t  2048 kB\nVmRSS:\t  1024 kB\n';
  assert.deepEqual(parseProcStatus(status), { name: 'postgres', ppid: 7, hwmKb: 2048, rssKb: 1024 });
  assert.deepEqual(parseProcStatus('Name:\tx\n'), { name: 'x', ppid: 0, hwmKb: null, rssKb: null });
});

test('classify finds the launcher tree and the postgres processes of the data folder only', () => {
  const procs = [
    { pid: 10, ppid: 1, name: 'sipges-desktop', cmdline: 'sipges-desktop --state /s' },
    { pid: 11, ppid: 10, name: 'api', cmdline: '/b/api' },
    // The postmaster, reparented away from pg_ctl, found by its data folder.
    { pid: 20, ppid: 1, name: 'postgres', cmdline: '/usr/bin/postgres -D /s/pg18 -p 5555' },
    { pid: 21, ppid: 20, name: 'postgres', cmdline: 'postgres: checkpointer' },
    // Another cluster on the same machine is not ours.
    { pid: 30, ppid: 1, name: 'postgres', cmdline: '/usr/bin/postgres -D /other/pg18' },
    { pid: 31, ppid: 30, name: 'postgres', cmdline: 'postgres: walwriter' },
    { pid: 40, ppid: 1, name: 'node', cmdline: 'node bench' },
  ];
  const c = classify(procs, 10, '/s/pg18', 'go');
  assert.deepEqual(c.launcher.map((p) => p.pid), [10]);
  assert.deepEqual(c.api.map((p) => p.pid), [11]);
  assert.deepEqual(c.database.map((p) => p.pid).sort(), [20, 21]);

  // TypeScript: the node process is the API and holds PGlite; no separate database process.
  const ts = classify([{ pid: 50, ppid: 1, name: 'node', cmdline: 'node main.ts' }], 50, '/s/pglite', 'ts');
  assert.deepEqual(ts.api.map((p) => p.pid), [50]);
  assert.deepEqual(ts.database, []);
  assert.deepEqual(ts.launcher, []);

  // Windows names and a data folder spelled with backslashes and another case.
  const win = classify(
    [
      { pid: 1, ppid: 0, name: 'sipges-desktop.exe', cmdline: 'x' },
      { pid: 2, ppid: 1, name: 'api.exe', cmdline: 'x' },
      { pid: 3, ppid: 9, name: 'postgres.exe', cmdline: '"C:\\B\\postgres.exe" -D "C:\\S\\PG18"' },
    ],
    1,
    'c:\\s\\pg18',
    'go',
  );
  assert.deepEqual(win.api.map((p) => p.pid), [2]);
  assert.deepEqual(win.database.map((p) => p.pid), [3]);
});

test('summarizeSamples keeps the peak of each role sum and of the total', () => {
  const peaks = summarizeSamples([
    { api: 100, database: 50, launcher: 5 },
    { api: 90, database: 80, launcher: 5 },
  ]);
  assert.deepEqual(peaks, { api: 100, database: 80, launcher: 5, total: 175 });
  assert.deepEqual(summarizeSamples([]), { api: null, database: null, launcher: null, total: null });
});

test('folderBytes adds the size of every file below a folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-bench-test-'));
  try {
    await mkdir(join(dir, 'a', 'b'), { recursive: true });
    await writeFile(join(dir, 'one'), 'x'.repeat(10));
    await writeFile(join(dir, 'a', 'b', 'two'), 'y'.repeat(32));
    assert.equal(await folderBytes(dir), 42);
    assert.equal(await folderBytes(join(dir, 'missing')), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('insertBatches splits each module into batches with stable ids', () => {
  const records = { Eventos: [{ a: 1 }, { a: 2 }, { a: 3 }], Alertas: [{ b: 1 }] };
  const batches = insertBatches(records, 2);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches[0], {
    module: 'Eventos',
    rows: [
      { id: 'Eventos-0', payload: { a: 1 } },
      { id: 'Eventos-1', payload: { a: 2 } },
    ],
  });
  assert.deepEqual(batches[1].rows, [{ id: 'Eventos-2', payload: { a: 3 } }]);
  assert.deepEqual(batches[2], { module: 'Alertas', rows: [{ id: 'Alertas-0', payload: { b: 1 } }] });
});

test('aggregate reports every repetition, the median and the outliers without dropping them', () => {
  const runs = [
    { size: 1, stack: 'go', rep: 0, metrics: { coldStartMs: 1000, rps8: 50 } },
    { size: 1, stack: 'go', rep: 1, metrics: { coldStartMs: 1100, rps8: 52 } },
    { size: 1, stack: 'go', rep: 2, metrics: { coldStartMs: 3000, rps8: 51 } },
    { size: 1, stack: 'ts', rep: 0, metrics: { coldStartMs: 5000, rps8: null } },
  ];
  const agg = aggregate(runs);
  const cold = agg['1']['go'].coldStartMs;
  assert.deepEqual(cold.values, [1000, 1100, 3000]);
  assert.equal(cold.median, 1100);
  assert.deepEqual(cold.outliers, [2]);
  assert.deepEqual(agg['1']['go'].rps8.outliers, []);
  assert.deepEqual(agg['1']['ts'].rps8, { values: [null], median: null, outliers: [] });
});

test('renderMarkdown prints one row per metric with both stacks and their ratio', () => {
  const runs = [
    { size: 1, stack: 'ts', rep: 0, metrics: { coldStartMs: 4000 } },
    { size: 1, stack: 'go', rep: 0, metrics: { coldStartMs: 1000 } },
  ];
  const md = renderMarkdown(aggregate(runs), [{ key: 'coldStartMs', label: 'Cold start (ms)' }]);
  assert.match(md, /### 1×/);
  assert.match(md, /\| Cold start \(ms\) \| 4000 \| 1000 \| 0\.25 \|/);
});
