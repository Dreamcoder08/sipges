// Kept from the second independent verification (desktop-updates L7): failures before any
// change are logged with their step and change nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { install, readCurrent, update } from './updater.mjs';
import {
  logLines,
  makePackage,
  makeState,
  newPair,
  noop,
  publicPem,
  releases,
  siblings,
  snapshot,
  withTemp,
} from './verifier-helpers.mjs';

test('advisory 5: an I/O error while staging is logged as failed with its step and changes nothing', () =>
  withTemp(async (dir) => {
    const pair = newPair();
    const rel = releases(dir, pair);
    const state = join(dir, 'state');
    await makeState(state);
    const root = join(dir, 'install');
    await install({
      root,
      release: await rel('1.0.0'),
      stateDir: state,
      trustKey: publicPem(pair),
    });
    const next = await rel('1.1.0');
    await chmod(join(next, 'package/web/index.html'), 0o000);
    const before = [await snapshot(root, (r) => r === 'update.log'), await snapshot(state)];
    await assert.rejects(
      update({ root, release: next, migrate: noop, ready: noop }),
      (e) => e.code === 'EACCES',
    );
    const last = (await logLines(root)).at(-1);
    assert.deepEqual([last.event, last.step, last.code], ['failed', 'stage', 'EACCES']);
    assert.deepEqual(
      [await snapshot(root, (r) => r === 'update.log'), await snapshot(state)],
      before,
    );
    assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
    assert.deepEqual(await siblings(state), []);
  }));

test('advisory 4: an adoption that fails while staging records no pointer and no state folder', () =>
  withTemp(async (dir) => {
    const pair = newPair();
    const rel = releases(dir, pair);
    const state = join(dir, 'state');
    await makeState(state);
    const old = join(dir, 'old');
    await makePackage(old, '0.9.0');
    const root = join(dir, 'install');
    const next = await rel('1.0.0');
    await chmod(join(next, 'package/web/index.html'), 0o000);
    await assert.rejects(
      update({
        root,
        release: next,
        adopt: { dir: old, stateDir: state },
        trustKey: publicPem(pair),
        migrate: noop,
        ready: noop,
      }),
      (e) => e.code === 'EACCES',
    );
    assert.equal(await readCurrent(root), null);
    assert.deepEqual((await readdir(root)).sort(), ['update.log', 'versions']);
    assert.deepEqual(await readdir(join(root, 'versions')), []);
    assert.deepEqual(
      (await logLines(root)).map((l) => l.event),
      ['failed'],
    );
  }));
