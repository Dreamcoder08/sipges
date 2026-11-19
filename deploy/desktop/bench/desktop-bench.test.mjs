// node --test deploy/desktop/bench/desktop-bench.test.mjs
/* global Response */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregate,
  bestEffort,
  classify,
  describeFailure,
  folderBytes,
  insertBatches,
  keepWorkFolder,
  killOrder,
  memoryMetricRows,
  memoryMetrics,
  parseOptions,
  progressLine,
  parseProcStatus,
  parseSmapsRollup,
  renderMarkdown,
  resolvePgBin,
  runOrder,
  summarizeSamples,
  timedRequest,
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

test('keepWorkFolder keeps a folder the run made only when the run failed', () => {
  assert.equal(keepWorkFolder({ ownWork: true, failed: false }), false);
  assert.equal(keepWorkFolder({ ownWork: true, failed: true }), true);
  // A folder the caller named is never removed.
  assert.equal(keepWorkFolder({ ownWork: false, failed: false }), true);
  assert.equal(keepWorkFolder({ ownWork: false, failed: true }), true);
});

test('parseOptions takes a logs folder', () => {
  assert.equal(parseOptions([]).logs, undefined);
  assert.equal(parseOptions(['--logs', 'out/logs']).logs, 'out/logs');
});

test('killOrder lists the tree below the root deepest first, then the root', () => {
  const procs = [
    { pid: 1, ppid: 0 },
    { pid: 2, ppid: 1 },
    { pid: 3, ppid: 2 },
    { pid: 4, ppid: 1 },
    { pid: 9, ppid: 0 },
  ];
  const order = killOrder(procs, 1);
  assert.deepEqual(order.at(-1), 1);
  assert.ok(order.indexOf(3) < order.indexOf(2), 'a child goes before its parent');
  assert.deepEqual([...order].sort(), [1, 2, 3, 4]);
  assert.deepEqual(killOrder(procs, 42), [42]);
});

test('resolvePgBin is only needed when the Go stack runs', () => {
  const never = () => {
    throw new Error('pg_config was called');
  };
  assert.equal(resolvePgBin({ stacks: ['ts'], pgBin: undefined, env: {}, find: never }), null);
  assert.equal(resolvePgBin({ stacks: ['go'], pgBin: '/opt/pg/bin', env: {}, find: never }), '/opt/pg/bin');
  assert.equal(
    resolvePgBin({ stacks: ['go'], pgBin: undefined, env: { SIPGES_PG_BIN: '/env/bin' }, find: never }),
    '/env/bin',
  );
  assert.equal(resolvePgBin({ stacks: ['ts', 'go'], pgBin: undefined, env: {}, find: () => '/found' }), '/found');
});

test('timedRequest gives up after its timeout and reports it', async () => {
  const hang = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const slow = await timedRequest(hang, 'http://x/api', { method: 'POST' }, 30);
  assert.equal(slow.ok, false);
  assert.equal(slow.status, 'timeout');
  const fine = await timedRequest(
    async () => new Response('{}', { status: 201 }),
    'http://x/api',
    { method: 'POST' },
    1_000,
  );
  assert.equal(fine.ok, true);
  assert.equal(fine.status, 201);
  assert.ok(fine.ms >= 0);
  const refused = await timedRequest(
    async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
    'http://x/api',
    {},
    1_000,
  );
  assert.deepEqual([refused.ok, refused.status], [false, 'neterr:ECONNREFUSED']);
});

test('memory metrics name one measure per row and differ by platform', () => {
  const roles = {
    api: [{ hwmKb: 2048 }],
    database: [{ hwmKb: 1024 }, { hwmKb: 1024 }],
    launcher: [{ hwmKb: 1024 }],
  };
  const peaks = { api: 3072, database: 4096, launcher: 1024, total: 8192 };
  assert.deepEqual(memoryMetrics({ windows: false, stack: 'go', roles, peaks }), {
    apiPeakRssMb: 2,
    apiPssPeakMb: 3,
    databasePssPeakMb: 4,
    totalPssPeakMb: 8,
  });
  assert.deepEqual(memoryMetrics({ windows: true, stack: 'go', roles, peaks: null }), {
    apiPeakWorkingSetMb: 2,
    databasePeakWorkingSetMb: 2,
    totalPeakWorkingSetMb: 5,
  });
  assert.equal(memoryMetrics({ windows: false, stack: 'ts', roles, peaks }).databasePssPeakMb, null);
  assert.equal(memoryMetrics({ windows: true, stack: 'ts', roles, peaks: null }).databasePeakWorkingSetMb, null);

  for (const windows of [false, true]) {
    const rows = memoryMetricRows(windows);
    const keys = Object.keys(memoryMetrics({ windows, stack: 'go', roles, peaks }));
    assert.deepEqual(rows.map((r) => r.key), keys);
    for (const { label } of rows) {
      const measures = ['RSS', 'Pss', 'working set'].filter((m) => label.includes(m));
      assert.equal(measures.length, 1, `one measure in "${label}"`);
    }
    // Each platform reports only its own measures.
    const foreign = windows ? ['RSS', 'Pss'] : ['working set'];
    assert.ok(rows.every((r) => foreign.every((m) => !r.label.includes(m))));
  }
});

test('killOrder ends when a reused Windows PID makes the parent links a cycle', () => {
  // 3's stale parent id points back at 1, which already sits above it.
  const procs = [
    { pid: 1, ppid: 3 },
    { pid: 2, ppid: 1 },
    { pid: 3, ppid: 2 },
  ];
  const order = killOrder(procs, 1);
  assert.deepEqual([...order].sort(), [1, 2, 3]);
  assert.equal(order.at(-1), 1);
  assert.equal(new Set(order).size, order.length, 'no pid twice');
  // A process that names itself as its parent.
  assert.deepEqual(killOrder([{ pid: 5, ppid: 5 }], 5), [5]);
});

test('describeFailure keeps the message and the stack trace', () => {
  const error = new Error('the server ended before it was ready');
  const described = describeFailure(error);
  assert.equal(described.error, 'the server ended before it was ready');
  assert.match(described.stack, /the server ended before it was ready\n\s+at /);
  // Something thrown that is not an Error still reads.
  assert.deepEqual(describeFailure('plain text'), { error: 'plain text', stack: null });
});

test('bestEffort never lets its own error replace the original failure', async () => {
  const seen = [];
  const original = new Error('seed failed');
  const run = async () => {
    try {
      throw original;
    } finally {
      await bestEffort(
        async () => {
          throw new Error('disk full');
        },
        (error) => seen.push(error.message),
      );
    }
  };
  await assert.rejects(run, (error) => error === original);
  assert.deepEqual(seen, ['disk full']);
  assert.equal(await bestEffort(async () => 7, () => undefined), undefined);
});

test('progressLine falls back to a dash for any missing value', () => {
  assert.equal(
    progressLine({ coldStartMs: 900, rps8: 650, apiPeakRssMb: 85 }, [1, 4, 8]),
    'ready 900 ms; 8 screen(s) 650 req/s; API peak 85 MB',
  );
  assert.equal(
    progressLine({ coldStartMs: 900, apiPeakWorkingSetMb: 120 }, [1, 4, 8]),
    'ready 900 ms; 8 screen(s) – req/s; API peak 120 MB',
  );
  assert.equal(progressLine({}, [2]), 'ready – ms; 2 screen(s) – req/s; API peak – MB');
});
