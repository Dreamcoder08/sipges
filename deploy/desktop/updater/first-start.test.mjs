// The first managed start over a state folder that already holds a database (closure-roadmap
// T33): the data of an older install opens in the managed version only through a dated copy and
// a rehearsal on a second copy, so a migration failure never touches the original folder.
// Migration is injected; no server is booted. Everything lives in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstStart, install, readCurrent, recover } from './updater.mjs';
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
  snapshot,
  withTemp,
} from './verifier-helpers.mjs';

const updateCli = join(dirname(fileURLToPath(import.meta.url)), 'update.mjs');

async function fixture(dir, { state: makeIt = makeState } = {}) {
  const pair = newPair();
  const root = join(dir, 'install');
  const state = join(dir, 'data', 'SIPGES');
  if (makeIt) await makeIt(state);
  const rel = releases(dir, pair);
  await install({
    root,
    release: await rel('1.0.0'),
    stateDir: state,
    trustKey: publicPem(pair),
  });
  return { root, state };
}

/** A migration that writes into the folder it is given, as the API does at boot, then fails. */
const breaking =
  (calls) =>
  async ({ stateDir }) => {
    calls.push(stateDir);
    await writeFile(join(stateDir, 'pglite', 'PG_VERSION'), 'half-migrated\n');
    throw new Error('migration 0033 failed');
  };
const migrating =
  (calls) =>
  async ({ stateDir }) => {
    calls.push(stateDir);
    await writeFile(join(stateDir, 'pglite', 'migrated'), 'yes\n');
  };
const named = (list, kind) => list.filter((name) => name.includes(`.${kind}-`));

test('rule a: a failed migration leaves the original state folder untouched', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir);
    const before = await snapshot(state);
    const calls = [];
    await assert.rejects(firstStart({ root, migrate: breaking(calls) }), (error) => {
      assert.equal(error.code, 'ROLLED_BACK');
      assert.match(error.message, /state folder was not touched/);
      return true;
    });
    // Only the rehearsal copy was ever handed to the migration.
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\.rehearsal-\d{8}T\d{6}Z-1\.0\.0$/);
    assert.deepEqual(await snapshot(state), before);
    const around = await siblings(state);
    assert.equal(named(around, 'failed').length, 0, 'nothing was restored: nothing was touched');
    const [copy] = named(around, 'pre-update');
    assert.match(copy, /^SIPGES\.pre-update-\d{8}T\d{6}Z-first-start-1\.0\.0$/);
    assert.deepEqual(await snapshot(join(dirname(state), copy)), before);
    // Not marked done: the next start tries again, still on copies.
    await rm(join(dirname(state), copy), { recursive: true });
    await assert.rejects(firstStart({ root, migrate: breaking(calls) }));
    assert.equal(calls.length, 2);
    assert.deepEqual(await snapshot(state), before);
    assert.deepEqual(
      (await logLines(root)).filter((l) => l.event.startsWith('first-start')).map((l) => l.event),
      ['first-start-failed', 'first-start-failed'],
    );
  }));

test('rule a: a migration that fails only on the real folder is undone from the dated copy', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir);
    const before = await snapshot(state);
    const calls = [];
    const migrate = async (target) =>
      calls.length === 0 ? migrating(calls)(target) : breaking(calls)(target);
    await assert.rejects(firstStart({ root, migrate }), { code: 'ROLLED_BACK' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1], state);
    assert.deepEqual(await snapshot(state), before);
    const around = await siblings(state);
    assert.equal(named(around, 'failed').length, 1, 'the changed folder is kept aside');
    assert.deepEqual(await snapshot(join(dirname(state), named(around, 'pre-update')[0])), before);
    assert.equal((await readCurrent(root)).version, '1.0.0');
  }));

test('rule a: the first start takes a dated pre-update copy, rehearses, then migrates', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir);
    const before = await snapshot(state);
    const calls = [];
    const result = await firstStart({
      root,
      migrate: migrating(calls),
      now: () => new Date('2026-11-11T10:20:30Z'),
    });
    const copy = `${state}.pre-update-20261111T102030Z-first-start-1.0.0`;
    assert.deepEqual(result, { done: true, version: '1.0.0', preUpdateCopy: copy });
    assert.deepEqual(calls, [`${state}.rehearsal-20261111T102030Z-1.0.0`, state]);
    assert.deepEqual(await snapshot(copy), before);
    assert.equal(await readFile(join(state, 'pglite', 'migrated'), 'utf8'), 'yes\n');
    const marker = JSON.parse(await readFile(join(root, 'first-start.json'), 'utf8'));
    assert.deepEqual(
      { ...marker, at: undefined },
      { format: 1, version: '1.0.0', stateDir: state, preUpdateCopy: copy, at: undefined },
    );
    const line = (await logLines(root)).find((l) => l.event === 'first-start');
    assert.equal(line.preUpdateCopy, copy);
  }));

test('rule d: a second first start over an already moved folder changes nothing', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir);
    const calls = [];
    await firstStart({ root, migrate: migrating(calls) });
    const [state1, around1, root1] = [
      await snapshot(state),
      await siblings(state),
      await snapshot(root),
    ];
    const again = await firstStart({ root, migrate: migrating(calls) });
    assert.deepEqual(again, { done: false, version: '1.0.0', preUpdateCopy: null });
    assert.equal(calls.length, 2, 'no migration ran the second time');
    assert.deepEqual(await snapshot(state), state1);
    assert.deepEqual(await siblings(state), around1);
    assert.deepEqual(await snapshot(root), root1);
  }));

test('a fresh state folder needs no copy: the first start is only recorded', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir, { state: null });
    const calls = [];
    const result = await firstStart({ root, migrate: migrating(calls) });
    assert.deepEqual(result, { done: true, version: '1.0.0', preUpdateCopy: null });
    assert.deepEqual(calls, []);
    // Nothing was created beside (or as) the state folder; the launcher prepares it afterwards.
    await assert.rejects(readdir(dirname(state)), { code: 'ENOENT' });
    assert.equal(
      JSON.parse(await readFile(join(root, 'first-start.json'), 'utf8')).version,
      '1.0.0',
    );
  }));

test('rule b: a database without its data key is refused before anything is written', () =>
  withTemp(async (dir) => {
    for (const secret of ['data-key', 'admin-password']) {
      const { root, state } = await fixture(join(dir, secret), {
        state: async (path) => {
          await makeState(path);
          await put(join(path, secret), '  \n');
        },
      });
      const before = await snapshot(state);
      const calls = [];
      await assert.rejects(firstStart({ root, migrate: migrating(calls) }), (error) => {
        assert.equal(error.code, 'REFUSED');
        assert.ok(error.message.includes(join(state, secret)), error.message);
        assert.match(error.message, /restore it from the backup/);
        return true;
      });
      assert.deepEqual(calls, []);
      assert.deepEqual(await snapshot(state), before);
      assert.deepEqual(await siblings(state), []);
      await assert.rejects(readFile(join(root, 'first-start.json')), { code: 'ENOENT' });
    }
  }));

test('rule b: the launcher never creates a new data key over an existing database', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir, {
      state: async (path) => {
        await makeState(path);
        await rm(join(path, 'data-key'));
      },
    });
    const lines = [];
    await assert.rejects(
      launch({
        root,
        port: await freePort(),
        log: (event, fields) => lines.push({ event, ...fields }),
        migrate: async () => {},
        ready: async () => {},
      }),
      { code: 'REFUSED' },
    );
    await assert.rejects(readFile(join(state, 'data-key')), { code: 'ENOENT' });
    assert.deepEqual(
      lines.map((l) => l.event),
      ['start_refused'],
    );
    assert.match(lines[0].action, /^SIPGES no se inició: /);
  }));

test('rule a: the launcher runs the first start before it starts any version', () =>
  withTemp(async (dir) => {
    const { root, state } = await fixture(dir);
    const before = await snapshot(state);
    const lines = [];
    const calls = [];
    await assert.rejects(
      launch({
        root,
        port: await freePort(),
        log: (event, fields) => lines.push({ event, ...fields }),
        migrate: breaking(calls),
        ready: async () => {},
      }),
      { code: 'ROLLED_BACK' },
    );
    assert.deepEqual(
      lines.map((l) => l.event),
      ['start_refused'],
    );
    assert.match(lines[0].action, /^SIPGES no se inició: .*no se tocaron/);
    assert.deepEqual(await snapshot(state), before);
  }));

test('update.mjs --first-start runs the same first start from a terminal', () =>
  withTemp(async (dir) => {
    const { root } = await fixture(dir, { state: null });
    const run = spawnSync(process.execPath, [updateCli, '--install', root, '--first-start'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^First start of 1\.0\.0 recorded; no existing database\.$/m);
    const again = spawnSync(process.execPath, [updateCli, '--install', root, '--first-start'], {
      encoding: 'utf8',
    });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^First start already done for 1\.0\.0; nothing changed\.$/m);
    const wrong = spawnSync(
      process.execPath,
      [updateCli, '--install', root, '--first-start', '--recover'],
      { encoding: 'utf8' },
    );
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /--first-start takes only --install/);
  }));

/** A start.mjs that answers on the rehearsal copy and hangs on the real folder, recording its pid. */
const hangingLiveStart = `
  import { writeFileSync } from 'node:fs';
  import { dirname, join } from 'node:path';
  import { createServer } from 'node:http';
  const state = dirname(process.env.SIPGES_PGLITE_DIR);
  if (state.includes('.rehearsal-')) {
    createServer((req, res) => res.end('ok'))
      .listen(Number(process.env.SIPGES_PORT), '127.0.0.1');
  } else {
    writeFileSync(join(state, 'live-child.pid'), String(process.pid));
  }
  setInterval(() => {}, 1000);
`;

test('T33/T35: stopping during firstStart also stops its live boot child', () =>
  withTemp(async (dir) => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const { setTimeout: sleep } = await import('node:timers/promises');
    const pair = newPair();
    const root = join(dir, 'install');
    const state = join(dir, 'state');
    await makeState(state);
    const release = await releases(dir, pair)('1.0.0', { start: hangingLiveStart });
    await install({ root, stateDir: state, release, trustKey: publicPem(pair) });
    let port;
    do {
      port = await freePort();
    } while ([8000, 18080].includes(port));
    const child = spawn(
      process.execPath,
      [join(dirname(updateCli), 'launcher.mjs'), '--install', root, '--port', String(port)],
      { stdio: 'ignore' },
    );
    const ended = once(child, 'exit');
    let livePid;
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          livePid = Number(await readFile(join(state, 'live-child.pid'), 'utf8'));
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await sleep(20);
      }
      assert.ok(livePid, 'live migration child must start');
      child.kill('SIGTERM');
      const [code] = await Promise.race([
        ended,
        sleep(3000).then(() => {
          throw new Error('launcher did not stop');
        }),
      ]);
      await sleep(200);
      let alive = true;
      try {
        process.kill(livePid, 0);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        alive = false;
      }
      assert.equal(alive, false, 'migration child survived launcher shutdown');
      // A stop during the first start is a normal stop: the folder is restored, nothing pending.
      assert.equal(code, 0);
      await assert.rejects(readFile(join(root, 'update-journal.json')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(state, 'live-child.pid')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(root, 'first-start.json')), { code: 'ENOENT' });
    } finally {
      child.kill('SIGKILL');
      if (livePid) {
        try {
          process.kill(livePid, 'SIGKILL');
        } catch {
          // Already gone, as it should be.
        }
      }
    }
  }));

test('T33/T35: a launcher killed during the live migration: its boot child ends and the next start restores the dated copy', () =>
  withTemp(async (dir) => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const { setTimeout: sleep } = await import('node:timers/promises');
    const pair = newPair();
    const root = join(dir, 'install');
    const state = join(dir, 'state');
    await makeState(state);
    const before = await snapshot(state);
    const release = await releases(dir, pair)('1.0.0', { start: hangingLiveStart });
    await install({ root, stateDir: state, release, trustKey: publicPem(pair) });
    let port;
    do {
      port = await freePort();
    } while ([8000, 18080].includes(port));
    const child = spawn(
      process.execPath,
      [join(dirname(updateCli), 'launcher.mjs'), '--install', root, '--port', String(port)],
      { stdio: 'ignore' },
    );
    const ended = once(child, 'exit');
    let livePid;
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        return false;
      }
    };
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          livePid = Number(await readFile(join(state, 'live-child.pid'), 'utf8'));
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await sleep(20);
      }
      assert.ok(livePid, 'live migration child must start');
      // A hard stop (no handler runs): the boot child must still end on its own.
      child.kill('SIGKILL');
      await ended;
      const gone = Date.now() + 3000;
      while (alive(livePid) && Date.now() < gone) await sleep(20);
      assert.equal(alive(livePid), false, 'the boot child outlived a killed launcher');
      const journal = JSON.parse(await readFile(join(root, 'update-journal.json'), 'utf8'));
      assert.equal(journal.phase, 'migrating');
      // The next start: recovery restores the folder from the dated copy, then the first start
      // runs again on copies first.
      const recovered = await recover({ root });
      assert.equal(recovered.recovered, true);
      assert.deepEqual(await snapshot(state), before);
      const around = await siblings(state);
      const [failed] = named(around, 'failed');
      assert.ok(failed, 'the changed folder is kept aside');
      assert.ok((await readdir(join(dirname(state), failed))).includes('live-child.pid'));
      const calls = [];
      const again = await firstStart({ root, migrate: migrating(calls) });
      assert.equal(again.done, true);
      assert.equal(calls.length, 2);
      assert.equal(calls[1], state);
      assert.deepEqual(await snapshot(state, (rel) => rel === 'pglite/migrated'), before);
      const events = (await logLines(root)).map((l) => l.event);
      assert.ok(events.includes('recovered'), events.join(','));
      assert.equal(events.at(-1), 'first-start');
    } finally {
      child.kill('SIGKILL');
      if (livePid && alive(livePid)) process.kill(livePid, 'SIGKILL');
    }
  }));
