// A restore halted halfway (the state folder moved aside as `.failed-…`, its fresh copy still
// `.restoring-…`) must never be reported recovered on a state folder created again since, as an
// installer rerun does: the launcher would then start on an empty database. Synthetic data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, readCurrent, recover } from './updater.mjs';
import {
  logLines,
  makeState,
  newPair,
  publicPem,
  releases,
  siblings,
  snapshot,
  withTemp,
} from './verifier-helpers.mjs';

const updateCli = join(dirname(fileURLToPath(import.meta.url)), 'update.mjs');

test('a halted restore is never reported recovered on a recreated, unrestored state folder', () =>
  withTemp(async (dir) => {
    const pair = newPair();
    const root = join(dir, 'app');
    const state = join(dir, 'SIPGES-datos');
    await makeState(state);
    await install({
      root,
      release: await releases(dir, pair)('1.0.0'),
      stateDir: state,
      trustKey: publicPem(pair),
    });
    const before = await snapshot(state);
    const pre = `${state}.pre-update-20261114T100000Z-1.0.0-to-1.1.0`;
    const failed = `${state}.failed-20261114T100000Z-1.1.0`;
    const restoring = `${state}.restoring-20261114T100000Z-x`;
    await cp(state, pre, { recursive: true });
    await cp(state, restoring, { recursive: true });
    await rename(state, failed);
    await writeFile(
      join(root, 'update-journal.json'),
      JSON.stringify({
        from: { version: '1.0.0', path: 'versions/1.0.0', adopted: false },
        to: { version: '1.1.0', path: 'versions/1.1.0' },
        stateDir: state,
        preCopy: pre,
        failedAside: failed,
        restoring,
        phase: 'restoring',
      }),
    );
    await mkdir(join(state, 'pglite'), { recursive: true }); // what an installer rerun creates
    const result = await recover({ root }).catch((error) => error);
    const restored = JSON.stringify(await snapshot(state)) === JSON.stringify(before);
    assert.ok(restored || result.code === 'ROLLBACK_INCOMPLETE', 'recovered without restoring');
    if (!restored) assert.ok(existsSync(join(root, 'update-journal.json')), 'journal kept');
  }));

/**
 * An installed 1.0.0 whose update to 1.1.0 halted in the restore: the migrated state moved aside
 * as `.failed-…` (it differs from the pre-update copy), its fresh copy still `.restoring-…` and
 * nothing at the state folder's name. The journal is written as the updater writes it.
 */
async function haltedRestore(dir) {
  const pair = newPair();
  const root = join(dir, 'app');
  const state = join(dir, 'SIPGES-datos');
  await makeState(state);
  await install({
    root,
    release: await releases(dir, pair)('1.0.0'),
    stateDir: state,
    trustKey: publicPem(pair),
  });
  const before = await snapshot(state);
  const pre = `${state}.pre-update-20261114T100000Z-1.0.0-to-1.1.0`;
  const failed = `${state}.failed-20261114T100000Z-1.1.0`;
  const restoring = `${state}.restoring-20261114T100000Z-x`;
  await cp(state, pre, { recursive: true, preserveTimestamps: true });
  await cp(state, restoring, { recursive: true, preserveTimestamps: true });
  await writeFile(join(state, 'pglite/PG_VERSION'), 'half migrated by 1.1.0\n');
  await rename(state, failed);
  const journal = join(root, 'update-journal.json');
  const journalText = `${JSON.stringify(
    {
      from: { version: '1.0.0', path: 'versions/1.0.0', adopted: false },
      to: { version: '1.1.0', path: 'versions/1.1.0' },
      stateDir: state,
      preCopy: pre,
      failedAside: failed,
      restoring,
      phase: 'restoring',
    },
    null,
    2,
  )}\n`;
  await writeFile(journal, journalText);
  return { root, state, before, pre, failed, restoring, journal, journalText };
}

/** Every folder beside the state folder and the state folder itself, by name. */
async function folders(state) {
  const out = {};
  for (const name of [...(await siblings(state)), state.split('/').at(-1)]) {
    const path = join(dirname(state), name);
    if (existsSync(path)) out[name] = await snapshot(path);
  }
  return out;
}

const recoverCli = (root) =>
  spawnSync(process.execPath, [updateCli, '--install', root, '--recover'], { encoding: 'utf8' });

test('a state folder created again while its restore waits is refused: journal and every folder kept', () =>
  withTemp(async (dir) => {
    const h = await haltedRestore(dir);
    await mkdir(join(h.state, 'pglite'), { recursive: true }); // what an installer rerun creates
    await mkdir(join(h.state, 'uploads'), { recursive: true });
    const untouched = await folders(h.state);
    const names = await siblings(h.state);
    assert.deepEqual(names.length, 3, 'pre-update, failed and restoring beside the state folder');

    const error = await recover({ root: h.root }).then(
      () => null,
      (failure) => failure,
    );
    assert.equal(error?.code, 'ROLLBACK_INCOMPLETE');
    assert.equal(error.preUpdateCopy, h.pre);
    assert.equal(
      error.message,
      `An interrupted update to 1.1.0 could not be rolled back (the state folder ${h.state} was created again while its restore was pending; the restored data is still in ${h.restoring}: move ${h.state} aside without deleting anything, then run --recover again). Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: ${h.pre}`,
    );
    assert.equal(await readFile(h.journal, 'utf8'), h.journalText, 'journal kept as it was');
    assert.deepEqual(await folders(h.state), untouched, 'no folder changed');
    assert.deepEqual(await siblings(h.state), names);
    assert.deepEqual(untouched[names.find((n) => n.includes('.restoring-'))], h.before);
    assert.equal((await readCurrent(h.root)).version, '1.0.0');
    const last = (await logLines(h.root)).at(-1);
    assert.deepEqual([last.event, last.phase], ['rollback-incomplete', 'restoring']);

    // The CLI says the same and exits 3; a retry changes nothing either.
    const cli = recoverCli(h.root);
    assert.deepEqual([cli.status, cli.stdout], [3, '']);
    assert.equal(cli.stderr, `Error: ${error.message}\n`);
    assert.equal(await readFile(h.journal, 'utf8'), h.journalText);
    assert.deepEqual(await folders(h.state), untouched);

    // The way out the message names: the recreated folder moved aside, then --recover.
    const aside = join(dir, 'recreated-aside');
    await rename(h.state, aside);
    const done = recoverCli(h.root);
    assert.deepEqual(
      [done.status, done.stdout, done.stderr],
      [0, 'Recovered: rolled back to 1.0.0.\n', ''],
    );
    assert.deepEqual(await snapshot(h.state), h.before);
    assert.equal(existsSync(h.journal), false);
    assert.deepEqual(await snapshot(aside), untouched['SIPGES-datos']);
  }));

test('a state folder that does not match the pre-update copy, with no restore waiting, is refused', () =>
  withTemp(async (dir) => {
    const h = await haltedRestore(dir);
    // The restore copy is gone (moved away by hand) and an installer rerun made a new folder.
    await rename(h.restoring, join(dir, 'moved-by-hand'));
    await mkdir(join(h.state, 'pglite'), { recursive: true });
    const untouched = await folders(h.state);

    const error = await recover({ root: h.root }).then(
      () => null,
      (failure) => failure,
    );
    assert.equal(error?.code, 'ROLLBACK_INCOMPLETE');
    assert.equal(
      error.message,
      `An interrupted update to 1.1.0 could not be rolled back (the state folder ${h.state} cannot be proven restored: it does not match the pre-update copy ${h.pre}). Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: ${h.pre}`,
    );
    assert.equal(await readFile(h.journal, 'utf8'), h.journalText);
    assert.deepEqual(await folders(h.state), untouched);
    assert.equal((await readCurrent(h.root)).version, '1.0.0');
  }));

test('a restored-looking state folder whose pre-update copy is gone is not proven restored', () =>
  withTemp(async (dir) => {
    const h = await haltedRestore(dir);
    await rename(h.restoring, h.state); // the restore finished
    await rename(h.pre, join(dir, 'pre-update-moved-by-hand'));
    const untouched = await folders(h.state);

    const error = await recover({ root: h.root }).then(
      () => null,
      (failure) => failure,
    );
    assert.equal(error?.code, 'ROLLBACK_INCOMPLETE');
    assert.equal(
      error.message,
      `An interrupted update to 1.1.0 could not be rolled back (the state folder ${h.state} cannot be proven restored: the pre-update copy ${h.pre} is missing). Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: ${h.pre}`,
    );
    assert.equal(await readFile(h.journal, 'utf8'), h.journalText);
    assert.deepEqual(await folders(h.state), untouched);
  }));

test('preserved: a halted restore with nothing at the state name still recovers', () =>
  withTemp(async (dir) => {
    const h = await haltedRestore(dir);
    const failedBefore = await snapshot(h.failed);
    const preBefore = await snapshot(h.pre);

    const result = await recover({ root: h.root });
    assert.deepEqual([result.version, result.recovered], ['1.0.0', true]);
    assert.deepEqual(await snapshot(h.state), h.before);
    assert.deepEqual(await snapshot(h.failed), failedBefore);
    assert.deepEqual(await snapshot(h.pre), preBefore);
    assert.equal(existsSync(h.restoring), false, 'the restore copy became the state folder');
    assert.equal(existsSync(h.journal), false);
    assert.equal((await logLines(h.root)).at(-1).event, 'recovered');
  }));

test('preserved: a restore that finished before its journal was removed still recovers', () =>
  withTemp(async (dir) => {
    const h = await haltedRestore(dir);
    await rename(h.restoring, h.state); // the last rename of the restore happened
    const failedBefore = await snapshot(h.failed);
    const preBefore = await snapshot(h.pre);
    const names = await readdir(dir);

    const result = await recover({ root: h.root });
    assert.deepEqual([result.version, result.recovered], ['1.0.0', true]);
    assert.deepEqual(await snapshot(h.state), h.before);
    assert.deepEqual(await snapshot(h.failed), failedBefore);
    assert.deepEqual(await snapshot(h.pre), preBefore);
    assert.deepEqual(await readdir(dir), names);
    assert.equal(existsSync(h.journal), false);
  }));

test('same names and sizes but other content is not proven restored', () =>
  withTemp(async (dir) => {
    const h = await haltedRestore(dir);
    await rename(h.restoring, join(dir, 'moved-by-hand'));
    await cp(h.pre, h.state, { recursive: true });
    await writeFile(join(h.state, 'pglite/base/1/16384'), '\0'.repeat(8192));
    const untouched = await folders(h.state);
    const error = await recover({ root: h.root }).then(
      () => null,
      (failure) => failure,
    );
    assert.equal(error?.code, 'ROLLBACK_INCOMPLETE');
    assert.equal(
      error.message,
      `An interrupted update to 1.1.0 could not be rolled back (the state folder ${h.state} cannot be proven restored: it does not match the pre-update copy ${h.pre}). Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: ${h.pre}`,
    );
    assert.equal(await readFile(h.journal, 'utf8'), h.journalText);
    assert.deepEqual(await folders(h.state), untouched);
  }));

test('a missing pre-update copy never costs the restore copy', () =>
  withTemp(async (dir) => {
    const h = await haltedRestore(dir);
    await rename(h.failed, h.state); // halted before the changed state was moved aside
    await rename(h.pre, join(dir, 'pre-update-moved-by-hand'));
    const untouched = await folders(h.state);
    const error = await recover({ root: h.root }).then(
      () => null,
      (failure) => failure,
    );
    assert.equal(error?.code, 'ROLLBACK_INCOMPLETE');
    assert.equal(
      error.message,
      `An interrupted update to 1.1.0 could not be rolled back (the pre-update copy ${h.pre} is missing; nothing was moved or deleted). Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: ${h.pre}`,
    );
    assert.deepEqual(await snapshot(h.restoring), h.before);
    assert.deepEqual(await folders(h.state), untouched, 'no folder changed');
    assert.equal(await readFile(h.journal, 'utf8'), h.journalText, 'journal kept as it was');
  }));
