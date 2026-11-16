// Kept from the second independent verification (desktop-updates L7): the heartbeat lock
// (defect 3) and its races. The race runs three processes per round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { install, recover } from './updater.mjs';
import { makeState, newPair, publicPem, releases, withTemp } from './verifier-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const child = join(here, 'verifier-race-child.mjs');
const UPDATER = pathToFileURL(join(here, 'updater.mjs')).href;
const ROUNDS = 6;
const PROCESSES = 3;
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const lockFiles = async (root) =>
  (await readdir(root)).filter((n) => n.startsWith('update.lock')).sort();

async function simple(dir) {
  const pair = newPair();
  const rel = releases(dir, pair);
  const state = join(dir, 'state');
  await makeState(state);
  const root = join(dir, 'install');
  await install({ root, release: await rel('1.0.0'), stateDir: state, trustKey: publicPem(pair) });
  return { rel, state, root, lock: join(root, 'update.lock') };
}
const v2 = (pid, heartbeat) =>
  JSON.stringify({ format: 2, pid, token: 'synthetic-token', heartbeat });

test('D3: locks left behind are taken over; a live, beating one is BUSY and left byte-identical', () =>
  withTemp(async (dir) => {
    const { root, lock } = await simple(dir);
    const taken = async (text, label) => {
      await writeFile(lock, text);
      assert.equal((await recover({ root })).version, '1.0.0', label);
      assert.deepEqual(await lockFiles(root), [], label);
    };
    await taken(v2(process.ppid, ago(180_000)), 'live foreign pid, heartbeat 3 min old');
    await taken(v2(deadPid(), ago(1_000)), 'dead pid, fresh heartbeat');
    await taken(JSON.stringify({ pid: process.ppid, time: ago(180_000) }), 'old format, 3 min old');
    await writeFile(lock, '');
    await utimes(lock, new Date(Date.now() - 180_000), new Date(Date.now() - 180_000));
    assert.equal((await recover({ root })).version, '1.0.0', 'empty lock, old file time');
    assert.deepEqual(await lockFiles(root), []);

    const busy = async (text, label) => {
      await writeFile(lock, text);
      await assert.rejects(recover({ root }), (e) => e.code === 'BUSY', label);
      assert.equal(await readFile(lock, 'utf8'), text, label);
      assert.deepEqual(await lockFiles(root), ['update.lock'], label);
      await rm(lock);
    };
    await busy(v2(process.ppid, ago(1_000)), 'live pid, fresh heartbeat');
    await busy(v2(process.ppid, ago(110_000)), 'live pid, heartbeat 110 s old');
    await busy('', 'empty lock just created');
    await busy('{"pid":', 'half-written lock just created');
  }));

test('D3 advisory: a reused pid with a heartbeat from the future stays BUSY', () =>
  withTemp(async (dir) => {
    const { root, lock } = await simple(dir);
    await writeFile(lock, v2(process.ppid, new Date(Date.now() + 86_400_000).toISOString()));
    await assert.rejects(recover({ root }), (e) => e.code === 'BUSY');
  }));

test(
  'D3: a live updater keeps its lock across heartbeats; others are BUSY; nothing is left',
  { timeout: 60_000 },
  () =>
    withTemp(async (dir) => {
      const { root, rel, lock } = await simple(dir);
      const release = await rel('1.1.0');
      const run = spawn(process.execPath, [child, UPDATER, root, release, '0', '24000', 'slow'], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      run.stdout.on('data', (d) => (out += d));
      while (!out.includes('MIGRATING')) await sleep(50);
      const seen = [];
      for (const wait of [0, 11_500, 11_500]) {
        await sleep(wait);
        await assert.rejects(
          recover({ root }),
          (e) => e.code === 'BUSY' && e.message.includes(`${run.pid}`),
        );
        seen.push(JSON.parse(await readFile(lock, 'utf8')));
      }
      assert.equal(new Set(seen.map((l) => l.token)).size, 1);
      assert.equal(
        seen.every((l) => l.pid === run.pid),
        true,
      );
      assert.equal(
        new Set(seen.map((l) => l.heartbeat)).size,
        3,
        JSON.stringify(seen.map((l) => l.heartbeat)),
      );
      const [code] = await once(run, 'exit');
      assert.equal(code, 0);
      assert.equal(JSON.parse(out.trim().split('\n').at(-1)).result, 'DONE');
      assert.deepEqual(await lockFiles(root), []);
    }),
);

test(
  'D3: many processes racing for one stale lock never hold it together',
  { timeout: 300_000 },
  () =>
    withTemp(async (dir) => {
      const { root, rel, lock } = await simple(dir);
      const release = await rel('1.1.0');
      const tally = {
        HELD: 0,
        BUSY: 0,
        other: [],
        notMine: 0,
        overlaps: 0,
        noHolder: 0,
        leftovers: [],
      };
      for (let round = 0; round < ROUNDS; round += 1) {
        await writeFile(lock, v2(deadPid(), ago(round % 2 ? 1_000 : 200_000)));
        const startAt = Date.now() + 400;
        const runs = Array.from(
          { length: PROCESSES },
          () =>
            new Promise((resolve) => {
              const run = spawn(
                process.execPath,
                [child, UPDATER, root, release, `${startAt}`, '40', 'race'],
                { stdio: ['ignore', 'pipe', 'inherit'] },
              );
              let out = '';
              run.stdout.on('data', (d) => (out += d));
              run.on('exit', () => resolve(JSON.parse(out.trim().split('\n').at(-1))));
            }),
        );
        const results = await Promise.all(runs);
        const held = results.filter((r) => r.result === 'HELD').sort((a, b) => a.enter - b.enter);
        tally.HELD += held.length;
        tally.BUSY += results.filter((r) => r.result === 'BUSY').length;
        tally.other.push(
          ...results
            .filter((r) => !['HELD', 'BUSY'].includes(r.result))
            .map((r) => `${r.result}: ${r.message}`),
        );
        tally.notMine += held.filter((r) => !r.mine).length;
        for (let i = 1; i < held.length; i += 1)
          if (held[i].enter < held[i - 1].exit) tally.overlaps += 1;
        if (held.length === 0) tally.noHolder += 1;
        tally.leftovers.push(...(await lockFiles(root)));
        for (const name of await lockFiles(root)) await rm(join(root, name));
      }
      assert.equal(tally.notMine, 0);
      assert.equal(tally.overlaps, 0);
      assert.deepEqual(tally.other, []);
      assert.deepEqual(tally.leftovers, []);
    }),
);
