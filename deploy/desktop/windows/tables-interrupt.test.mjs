// tables-interrupt.mjs: tables.mjs interrupted for real mid-copy, on this system (SIGINT on Linux
// and macOS, a console Ctrl+C through tables-interrupt.ps1 on Windows), with this checkout's PGlite
// on synthetic folders in a fresh temp folder, removed at the end. Plus the loud failures: a run
// that never began copying, and one that ignored the interrupt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { INTERRUPTED, interruptDrill, parseOptions } from './tables-interrupt.mjs';

const withWork = async (run) => {
  const work = await mkdtemp(join(tmpdir(), 'sipges-tables-interrupt-test-'));
  try {
    return await run(work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};
const quiet = { say: () => {}, check: (ok, label) => assert.ok(ok, label) };

test('options: a fresh work folder under the temp folder by default; logs inside it', () => {
  const now = new Date('2026-11-15T09:08:07.000Z');
  assert.deepEqual(parseOptions([], { now, tmp: '/tmp' }), {
    work: join('/tmp', 'sipges-tables-interrupt-20261115T090807Z'),
    logs: join('/tmp', 'sipges-tables-interrupt-20261115T090807Z', 'logs'),
  });
  // Resolved like the options are, so the expectation holds on win32 (a drive letter) too.
  assert.deepEqual(parseOptions(['--work', '/w', '--logs', '/l'], { now }), {
    work: resolve('/w'),
    logs: resolve('/l'),
  });
  for (const args of [['--work'], ['--other', 'x'], ['--work', 'a', '--work', 'b']])
    assert.throws(() => parseOptions(args, { now }), /^Error: invalid option /);
});

// functional-10 T15: a reused work folder would mix an old run's copies into this one's checks.
test('a work folder that already holds a tables-interrupt folder with files is refused untouched', () =>
  withWork(async (work) => {
    const dir = join(work, 'tables-interrupt');
    await mkdir(join(dir, 'scratch', 'sipges-tables-old'), { recursive: true });
    await writeFile(join(dir, 'left.txt'), 'synthetic, from an earlier run');
    await assert.rejects(interruptDrill({ work, ...quiet }), {
      message: `${dir} is not empty: tables-interrupt.mjs needs a fresh work folder (pass another --work, or remove ${dir})`,
    });
    assert.deepEqual((await readdir(dir)).sort(), ['left.txt', 'scratch']);
    assert.deepEqual(await readdir(join(dir, 'scratch')), ['sipges-tables-old']);
    assert.equal(await readFile(join(dir, 'left.txt'), 'utf8'), 'synthetic, from an earlier run');
  }));

test('tables.mjs interrupted mid-copy: exit 2, not compared (interrupted), nothing left', () =>
  withWork(async (work) => {
    const said = [];
    const checks = [];
    const result = await interruptDrill({
      work,
      say: (line) => said.push(line),
      check: (ok, label) => {
        assert.ok(ok, label);
        checks.push(label);
      },
      log: (name) => join(work, `${name}.txt`),
    });
    assert.deepEqual(result, {
      interrupt: process.platform === 'win32' ? 'console Ctrl+C' : 'SIGINT',
    });
    for (const label of [
      'the interrupt was sent while the run was copying',
      'interrupted run: exit 2 (got 2)',
      `interrupted run: last line ${INTERRUPTED}`,
      'interrupted run: it said it was removing the scratch copy it had begun',
      'interrupted run: scratch empty afterwards ()',
      'interrupted run: no seeded value printed',
    ])
      assert.ok(checks.includes(label), `${label}\n${checks.join('\n')}`);
    assert.ok(said.includes('tables.mjs: Ctrl+C mid-copy left no copy and both inputs unchanged'));
    assert.deepEqual(
      (await readdir(work)).filter((name) => name.endsWith('.txt')),
      ['interrupted.txt'],
    );
  }));

test('a run that ends before it copies anything fails loudly: no interrupt was sent', () =>
  withWork(async (work) => {
    const fake = join(work, 'fake-tables.mjs');
    await writeFile(fake, "console.log('RESULT: no difference');\n");
    await assert.rejects(
      interruptDrill({ work, script: fake, ...quiet, timeoutMs: 20_000 }),
      (error) => {
        assert.match(
          error.message,
          /^Check failed: the run began copying before the interrupt \(never\)\n/,
        );
        assert.match(error.message, /\nexit code 0\r?\n--- stdout\r?\nRESULT: no difference\r?\n/);
        return true;
      },
    );
  }));

test('a run that ignores the interrupt fails loudly with its exit code and output', () =>
  withWork(async (work) => {
    // A stand-in that begins a copy, ignores Ctrl+C and leaves its copy behind.
    const fake = join(work, 'fake-tables.mjs');
    await writeFile(
      fake,
      [
        "import { mkdirSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "process.on('SIGINT', () => {});",
        "const scratch = process.argv[process.argv.indexOf('--scratch') + 1];",
        "mkdirSync(join(scratch, 'sipges-tables-fake', 'before'), { recursive: true });",
        "setTimeout(() => console.log('RESULT: no difference'), 500);",
        '',
      ].join('\n'),
    );
    await assert.rejects(
      interruptDrill({ work, script: fake, ...quiet, timeoutMs: 20_000 }),
      (error) => {
        assert.match(error.message, /^Check failed: interrupted run: exit 2 \(got 0\)\n/);
        assert.match(error.message, /\nRESULT: no difference\r?\n--- stderr\r?\n--- end\r?\nhelper: /);
        return true;
      },
    );
  }));
