// The laptop-kit rehearsal only runs on Windows (.github/workflows/windows-desktop.yml, job
// laptop-kit); these tests cover what it decides on its own: what it measures, when the
// measures fail the job, and how it proves the old clone unchanged. Synthetic files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTemp } from '../updater/verifier-helpers.mjs';
import { BUILD_FREE, KIT_FREE, LAPTOP_FREE_GB } from './visit-kit.mjs';
import { bytesOf, checkMeasures, measureLines, trackedDigest } from './laptop-kit.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'laptop-kit.mjs');
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

test('bytesOf counts regular files and follows no link', () =>
  withTemp(async (dir) => {
    await mkdir(join(dir, 'a', 'b'), { recursive: true });
    await writeFile(join(dir, 'a', 'one'), 'x'.repeat(10));
    await writeFile(join(dir, 'a', 'b', 'two'), 'y'.repeat(5));
    await mkdir(join(dir, 'outside'));
    await writeFile(join(dir, 'outside', 'big'), 'z'.repeat(1000));
    await symlink(join(dir, 'outside'), join(dir, 'a', 'link'), 'dir');
    assert.equal(await bytesOf(join(dir, 'a')), 15);
    assert.equal(await bytesOf(join(dir, 'missing')), 0);
  }));

test('trackedDigest changes with a tracked file and ignores untracked ones', () =>
  withTemp(async (dir) => {
    const git = (...args) => {
      const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git('init', '--quiet');
    await mkdir(join(dir, 'deploy'));
    await writeFile(join(dir, 'deploy', 'start.ps1'), 'synthetic\n');
    await writeFile(join(dir, 'README.md'), 'readme\n');
    git('add', 'deploy/start.ps1', 'README.md');
    const first = await trackedDigest(dir);
    assert.equal(first.files, 2);
    await writeFile(join(dir, 'untracked.txt'), 'new\n');
    await mkdir(join(dir, 'node_modules'));
    await writeFile(join(dir, 'node_modules', 'x.js'), '1\n');
    assert.deepEqual(await trackedDigest(dir), first, 'untracked files do not count');
    await writeFile(join(dir, 'README.md'), 'readme!\n');
    assert.notEqual((await trackedDigest(dir)).digest, first.digest);
  }));

test('the measures fail the job when they leave less than twice the room asked for', () => {
  const fits = {
    cloneBytes: 80 * MiB,
    installBytes: 700 * MiB,
    buildBytes: 300 * MiB,
    releaseBytes: 250 * MiB,
  };
  assert.deepEqual(checkMeasures(fits), []);
  assert.deepEqual(
    checkMeasures({ ...fits, buildBytes: BUILD_FREE / 2 + 1 }).map((line) => line.split(',')[0]),
    ['the build added 512 MB to the clone'],
  );
  assert.match(
    checkMeasures({ ...fits, releaseBytes: KIT_FREE / 2 + 1 })[0],
    /^the signed release is 512 MB, more than half of KIT_FREE \(1024 MB\) in visit-kit\.mjs: raise it$/,
  );
  assert.match(
    checkMeasures({ ...fits, installBytes: (LAPTOP_FREE_GB / 2) * GiB })[0],
    /more than half of LAPTOP_FREE_GB \(5 GB\): raise it in visit-kit\.mjs and the runbook$/,
  );
  assert.deepEqual(
    measureLines({ seconds: { clone: 12, install: 90, kit: 60 }, ...fits }),
    [
      'git clone: 0.2 min, 80 MB',
      'pnpm install --frozen-lockfile: 1.5 min, 700 MB',
      'visit-kit.mjs: 1.0 min, 300 MB in the clone, 250 MB signed release',
      'total: 2.7 min, 1330 MB (the runbook asks 5 GB free)',
    ],
  );
});

test('CLI: off Windows it refuses with exit code 1', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'LAPTOP KIT REHEARSAL FAILED: the laptop-kit rehearsal runs on Windows only\n',
  );
});
