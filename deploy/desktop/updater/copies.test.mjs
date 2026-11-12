// The copies left beside the state folder (pre-update, rehearsal and failed copies) are never
// deleted automatically. They are recorded, counted with their size at every start, listed by
// `update.mjs --copies`, and removed only by the explicit `--remove-copies-older-than <days>`,
// which never removes the newest pre-update copy. Synthetic state folders in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstStart, install, listStateCopies, removeStateCopies } from './updater.mjs';
import { launch } from './launcher.mjs';
import { freePort } from './boot.mjs';
import {
  logLines,
  makeState,
  newPair,
  publicPem,
  put,
  releases,
  siblings,
  withTemp,
} from './verifier-helpers.mjs';

const updateCli = join(dirname(fileURLToPath(import.meta.url)), 'update.mjs');

const APP = `import { createServer } from 'node:http';
const server = createServer((req, res) => res.end('{}'));
server.listen(Number(process.env.SIPGES_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

async function fixture(dir) {
  const pair = newPair();
  const root = join(dir, 'install');
  const state = join(dir, 'data', 'SIPGES');
  await makeState(state);
  const release = await releases(dir, pair)('1.0.0', { start: APP });
  await install({ root, release, stateDir: state, trustKey: publicPem(pair) });
  return { root, state };
}

const stampOf = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000);

/** A copy beside the state folder as the updater names it, holding `bytes` bytes. */
async function copy(state, kind, date, suffix, bytes = 100) {
  const path = `${state}.${kind}-${stampOf(date)}-${suffix}`;
  await put(join(path, 'pglite', 'PG_VERSION'), 'x'.repeat(bytes));
  return path;
}

const cli = (args) => spawnSync(process.execPath, [updateCli, ...args], { encoding: 'utf8' });

test('the first start records its copies; the list counts them with their size and nothing else', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir);
    const result = await firstStart({ root, migrate: async () => {} });
    const line = (await logLines(root)).find((l) => l.event === 'first-start');
    assert.match(line.rehearsalCopy, /\.rehearsal-\d{8}T\d{6}Z-1\.0\.0$/);
    assert.equal(line.preUpdateCopy, result.preUpdateCopy);
    // Not copies: an unfinished copy, another folder with a similar name, a plain file.
    await put(join(`${state}.pre-update-20200101T000000Z-x.partial`, 'f'), 'partial');
    await put(join(`${state}-otro`, 'f'), 'other');
    await writeFile(`${state}.pre-update-notes.txt`, 'a file');
    const listed = await listStateCopies({ root });
    assert.equal(listed.stateDir, state);
    assert.deepEqual(
      listed.copies.map((c) => [c.kind, c.path]),
      [
        ['pre-update', result.preUpdateCopy],
        ['rehearsal', line.rehearsalCopy],
      ],
    );
    assert.equal(listed.count, 2);
    assert.ok(listed.bytes > 8192 * 2, `bytes ${listed.bytes}`);
    assert.equal(listed.bytes, listed.copies[0].bytes + listed.copies[1].bytes);
    assert.equal(listed.newestPreUpdate, result.preUpdateCopy);
  }));

test('the launcher reports how many copies exist and their total size when it starts', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir);
    await copy(state, 'pre-update', daysAgo(40), '1.0.0-to-1.1.0', 300);
    await copy(state, 'failed', daysAgo(40), '1.1.0', 200);
    const lines = [];
    const running = await launch({
      root,
      port: await freePort(),
      log: (event, fields) => lines.push({ event, ...fields }),
      migrate: async () => {},
      ready: async () => {},
    });
    try {
      const started = lines.find((l) => l.event === 'started');
      // The first start of this install added its own pre-update and rehearsal copies.
      assert.equal(started.stateCopies.count, 4);
      assert.ok(started.stateCopies.bytes > 500);
    } finally {
      await running.stop();
    }
  }));

test('removing old copies never removes the newest pre-update copy, even when it is old', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir);
    const oldest = await copy(state, 'pre-update', daysAgo(90), 'first-start-1.0.0');
    const rehearsal = await copy(state, 'rehearsal', daysAgo(90), '1.0.0');
    const failed = await copy(state, 'failed', daysAgo(50), '1.1.0');
    const newest = await copy(state, 'pre-update', daysAgo(40), '1.0.0-to-1.1.0');
    const recent = await copy(state, 'rehearsal', daysAgo(2), '1.2.0');
    const result = await removeStateCopies({ root, olderThanDays: 30 });
    assert.deepEqual(result.removed.map((c) => c.path).sort(), [failed, oldest, rehearsal].sort());
    assert.equal(result.kept, newest);
    assert.deepEqual(
      (await siblings(state)).map((name) => join(dirname(state), name)),
      [newest, recent],
    );
    const logged = (await logLines(root)).find((l) => l.event === 'copies-removed');
    assert.equal(logged.olderThanDays, 30);
    assert.equal(logged.kept, newest);
    assert.equal(logged.removed.length, 3);
  }));

test('update.mjs lists the copies and removes old ones, saying which copy it refused to remove', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir);
    const only = await copy(state, 'pre-update', daysAgo(60), 'first-start-1.0.0', 1000);
    const rehearsal = await copy(state, 'rehearsal', daysAgo(60), '1.0.0', 500);
    const listed = cli(['--install', root, '--copies']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`^Copies beside ${state}: 2, \\d+ bytes\\n`));
    assert.match(listed.stdout, /^ {2}pre-update \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \d+ bytes .+$/m);

    const removed = cli(['--install', root, '--remove-copies-older-than', '30']);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, new RegExp(`^Removed ${rehearsal} \\(\\d+ bytes\\)$`, 'm'));
    assert.match(
      removed.stdout,
      new RegExp(`^Kept ${only}: the newest pre-update copy is never removed\\.$`, 'm'),
    );
    assert.match(removed.stdout, /^Removed 1 copy \(\d+ bytes\); 1 left beside .+\.$/m);
    assert.deepEqual(
      (await siblings(state)).map((name) => join(dirname(state), name)),
      [only],
    );

    // Again: the newest pre-update copy is all that is left, and it stays.
    const again = cli(['--install', root, '--remove-copies-older-than', '30']);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^Kept .+: the newest pre-update copy is never removed\.$/m);
    assert.match(again.stdout, /^Nothing removed\.$/m);
    assert.deepEqual(await siblings(state), [only.slice(dirname(state).length + 1)]);
  }));

test('removing copies is refused while an update is pending or halted, and for a bad age', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir);
    await copy(state, 'pre-update', daysAgo(60), 'first-start-1.0.0');
    await copy(state, 'rehearsal', daysAgo(60), '1.0.0');
    const before = await siblings(state);
    for (const days of ['0', '-3', 'treinta', '1.5']) {
      const bad = cli(['--install', root, '--remove-copies-older-than', days]);
      assert.equal(bad.status, 1, days);
      assert.match(bad.stderr, /whole number of days/);
    }
    // A journal left by a halted update: its pre-update copy may be the only way back.
    await writeFile(join(root, 'update-journal.json'), '{"phase":"migrating"}\n');
    const refused = cli(['--install', root, '--remove-copies-older-than', '30']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /^Error: An update is pending or halted/m);
    assert.deepEqual(await siblings(state), before);
    assert.deepEqual((await readdir(root)).includes('update-journal.json'), true);
  }));
