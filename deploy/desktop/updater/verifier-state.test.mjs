// Kept from the second independent verification (desktop-updates L7): linked state folders
// (defect 2) and the free-space check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

const breakIt = async ({ stateDir }) => {
  await writeFile(join(stateDir, 'pglite/PG_VERSION'), 'broken by a synthetic migration\n');
  await writeFile(join(stateDir, 'half-migrated'), 'x');
  throw new Error('synthetic migration failure');
};
const notLog = (rel) => rel === 'update.log';
const recorded = async (root) =>
  JSON.parse(await readFile(join(root, 'install.json'), 'utf8')).stateDir;

test('D2: a state folder whose parent is a link is recorded real, copied for real and restored', () =>
  withTemp(async (dir) => {
    const pair = newPair();
    const rel = releases(dir, pair);
    const real = join(dir, 'realparent', 'state');
    await makeState(real);
    await symlink(join(dir, 'realparent'), join(dir, 'linkparent'), 'dir');
    const root = join(dir, 'install');
    await install({
      root,
      release: await rel('1.0.0'),
      stateDir: join(dir, 'linkparent', 'state'),
      trustKey: publicPem(pair),
    });
    assert.equal(await recorded(root), real);
    const before = await snapshot(real);
    await assert.rejects(
      update({ root, release: await rel('1.1.0'), migrate: breakIt, ready: noop }),
      (e) => e.code === 'ROLLED_BACK',
    );
    assert.deepEqual(await snapshot(real), before);
    const pre = (await siblings(real)).find((n) => n.includes('.pre-update-'));
    assert.equal((await lstat(join(dirname(real), pre))).isDirectory(), true);
    assert.deepEqual(await snapshot(join(dirname(real), pre)), before);
    assert.equal((await readCurrent(root)).version, '1.0.0');
  }));

test('D2: a parent swapped for a link after install still gets a real copy and a real restore', () =>
  withTemp(async (dir) => {
    const pair = newPair();
    const rel = releases(dir, pair);
    const state = join(dir, 'p', 'state');
    await makeState(state);
    const root = join(dir, 'install');
    await install({
      root,
      release: await rel('1.0.0'),
      stateDir: state,
      trustKey: publicPem(pair),
    });
    await rename(join(dir, 'p'), join(dir, 'q'));
    await symlink(join(dir, 'q'), join(dir, 'p'), 'dir');
    const before = await snapshot(join(dir, 'q', 'state'));
    await assert.rejects(
      update({ root, release: await rel('1.1.0'), migrate: breakIt, ready: noop }),
      (e) => e.code === 'ROLLED_BACK',
    );
    assert.deepEqual(await snapshot(join(dir, 'q', 'state')), before);
    const pre = (await readdir(join(dir, 'q'))).find((n) => n.includes('.pre-update-'));
    assert.equal((await lstat(join(dir, 'q', pre))).isDirectory(), true);
    assert.deepEqual(await snapshot(join(dir, 'q', pre)), before);
  }));

const shapes = {
  'a link to a folder outside, inside uploads': async (dir, state) => {
    await mkdir(join(dir, 'outside'));
    await symlink(join(dir, 'outside'), join(state, 'uploads', 'shared'), 'dir');
  },
  'a link to a file, deep inside pglite': async (dir, state) => {
    await writeFile(join(dir, 'outside-file'), 'x');
    await symlink(join(dir, 'outside-file'), join(state, 'pglite/base/1/16385'));
  },
  'a dangling link': async (dir, state) => symlink(join(dir, 'missing'), join(state, 'dangling')),
  'a named pipe': async (dir, state) =>
    void execFileSync('mkfifo', [join(state, 'pglite', 'pipe')]),
  'the folder itself swapped for a link': async (dir, state) => {
    await rename(state, join(dir, 'state-real'));
    await symlink(join(dir, 'state-real'), state, 'dir');
  },
};
for (const [name, make] of Object.entries(shapes))
  test(`D2: ${name}, created after install, is refused and nothing changes`, () =>
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
      await make(dir, state);
      const before = [
        await snapshot(root, notLog),
        await snapshot(dir, (r) => r.startsWith('install')),
      ];
      let migrated = 0;
      await assert.rejects(
        update({ root, release: next, migrate: async () => void (migrated += 1), ready: noop }),
        (e) => e.code === 'REFUSED' && /is a link|holds a link or special file/.test(e.message),
      );
      assert.equal(migrated, 0);
      assert.deepEqual(
        [await snapshot(root, notLog), await snapshot(dir, (r) => r.startsWith('install'))],
        before,
      );
      assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
      assert.equal((await logLines(root)).at(-1).event, 'refused');
    }));

test('D2: a hard-linked file inside the state is copied as its own file', () =>
  withTemp(async (dir) => {
    const pair = newPair();
    const rel = releases(dir, pair);
    const state = join(dir, 'state');
    await makeState(state);
    await link(join(state, 'pglite/PG_VERSION'), join(dir, 'peer'));
    const root = join(dir, 'install');
    await install({
      root,
      release: await rel('1.0.0'),
      stateDir: state,
      trustKey: publicPem(pair),
    });
    const before = await snapshot(state);
    await assert.rejects(
      update({ root, release: await rel('1.1.0'), migrate: breakIt, ready: noop }),
      (e) => e.code === 'ROLLED_BACK',
    );
    assert.deepEqual(await snapshot(state), before);
  }));

test('D2: adoption through a linked state path records the real folder; a failed rehearsal leaves it untouched', () =>
  withTemp(async (dir) => {
    const pair = newPair();
    const rel = releases(dir, pair);
    const real = join(dir, 'state-real');
    await makeState(real);
    await symlink(real, join(dir, 'state-link'), 'dir');
    const old = join(dir, 'old');
    await makePackage(old, '0.9.0');
    const root = join(dir, 'install');
    const before = await snapshot(real);
    const seen = [];
    await assert.rejects(
      update({
        root,
        release: await rel('1.0.0'),
        adopt: { dir: old, stateDir: join(dir, 'state-link') },
        trustKey: publicPem(pair),
        migrate: async ({ stateDir }) => {
          seen.push(stateDir);
          await breakIt({ stateDir });
        },
        ready: noop,
      }),
      (e) => e.code === 'ROLLED_BACK' && /rehearsal/.test(e.message),
    );
    assert.equal(await recorded(root), real);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /state-real\.rehearsal-/);
    assert.deepEqual(await snapshot(real), before);
    for (const n of await siblings(real))
      assert.equal((await lstat(join(dir, n))).isDirectory(), true, n);
  }));

// Free-space check ---------------------------------------------------------------------------
async function simple(dir) {
  const pair = newPair();
  const rel = releases(dir, pair);
  const state = join(dir, 'data', 'state');
  await makeState(state);
  const root = join(dir, 'install');
  await install({ root, release: await rel('1.0.0'), stateDir: state, trustKey: publicPem(pair) });
  return { pair, rel, state, root };
}
const needed = async (attempt) => {
  try {
    await attempt;
  } catch (e) {
    return Number(/: (\d+) bytes needed/.exec(e.message)?.[1]);
  }
  return NaN;
};

test('room: the boundary is exact and uses blocks times block size beside the state folder', () =>
  withTemp(async (dir) => {
    const { rel, state, root } = await simple(dir);
    const next = await rel('1.1.0');
    const asked = [];
    const disk = (bavail, bsize) => async (path) => {
      asked.push(path);
      return { bavail, bsize };
    };
    const need = await needed(
      update({ root, release: next, migrate: noop, ready: noop, statfs: disk(0, 4096) }),
    );
    // 5 files (8280 bytes) and 11 entries of 4096, twice.
    assert.equal(need, 2 * (8280 + 11 * 4096));
    assert.deepEqual(asked, [dirname(state)]);
    const before = [await snapshot(root, notLog), await snapshot(dirname(state))];
    await assert.rejects(
      update({ root, release: next, migrate: noop, ready: noop, statfs: disk(need - 1, 1) }),
      (e) => e.code === 'REFUSED',
    );
    await assert.rejects(
      update({ root, release: next, migrate: noop, ready: noop, statfs: disk(1, need - 1) }),
      (e) => e.code === 'REFUSED',
    );
    assert.deepEqual([await snapshot(root, notLog), await snapshot(dirname(state))], before);
    assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
    const done = await update({
      root,
      release: next,
      migrate: noop,
      ready: noop,
      statfs: disk(need / 2, 2),
    });
    assert.equal(done.to, '1.1.0');
  }));

test('room: an adopted install needs three copies, and a refusal records no adoption', () =>
  withTemp(async (dir) => {
    const pair = newPair();
    const rel = releases(dir, pair);
    const state = join(dir, 'state');
    await makeState(state);
    const old = join(dir, 'old');
    await makePackage(old, '0.9.0');
    const root = join(dir, 'install');
    const next = await rel('1.0.0');
    const args = {
      root,
      release: next,
      adopt: { dir: old, stateDir: state },
      trustKey: publicPem(pair),
      migrate: noop,
      ready: noop,
    };
    const need = await needed(
      update({ ...args, statfs: async () => ({ bavail: 0, bsize: 4096 }) }),
    );
    assert.equal(need, 3 * (8280 + 11 * 4096));
    assert.deepEqual((await readdir(root)).sort(), ['update.log']);
    assert.equal(await readCurrent(root), null);
    assert.deepEqual(await siblings(state), []);
  }));

test('room: the real disk here is not refused by mistake', () =>
  withTemp(async (dir) => {
    const { rel, root } = await simple(dir);
    assert.equal(
      (await update({ root, release: await rel('1.1.0'), migrate: noop, ready: noop })).to,
      '1.1.0',
    );
  }));
