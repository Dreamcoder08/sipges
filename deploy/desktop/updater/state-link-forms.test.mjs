// update.mjs --install … --state <link>: every spelling of a link (relative, trailing `/`, `//`,
// `/.`, `/sub/..`, a chain, a dangling link, a link to a file) is refused with exit 1 before the
// install root is created, and the link's target is left as it was. Synthetic data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeState, newPair, releases, snapshot, withTemp } from './verifier-helpers.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'update.mjs');

/** Runs the CLI from `cwd`, so a relative --state is resolved there. */
const installWith = (cwd, root, release, state) =>
  spawnSync(
    process.execPath,
    [cli, '--install', root, '--release', release, '--state', state, '--trust-release-key'],
    { cwd, encoding: 'utf8' },
  );

const refused = (link) =>
  `Error: The state folder ${link} is a link or junction: pass the real folder of the copy, never a link to it\n`;

test('update.mjs --install refuses every spelling of a link given as --state', () =>
  withTemp(async (dir) => {
    const release = await releases(dir, newPair())('1.0.0');
    const target = join(dir, 'copy');
    await makeState(target);
    const file = join(dir, 'a-file');
    await writeFile(file, 'synthetic\n');
    symlinkSync(target, join(dir, 'link'));
    symlinkSync(join(dir, 'link'), join(dir, 'chain')); // chain -> link -> copy
    symlinkSync(join(dir, 'missing'), join(dir, 'dangling'));
    symlinkSync(file, join(dir, 'file-link'));
    const before = await snapshot(dir);
    for (const [given, link] of [
      ['link', 'link'],
      ['./link/', 'link'],
      ['link//', 'link'],
      ['link/.', 'link'],
      ['link/sub/..', 'link'],
      ['chain', 'chain'],
      ['dangling', 'dangling'],
      ['file-link', 'file-link'],
    ]) {
      const root = join(dir, 'root');
      const result = installWith(dir, root, release, given);
      assert.equal(result.status, 1, `${given}: ${result.stderr}`);
      assert.equal(result.stderr, refused(join(dir, link)), given);
      assert.equal(existsSync(root), false, `${given}: the install root was not created`);
      assert.deepEqual(await snapshot(dir), before, `${given}: the target is unchanged`);
    }
  }));

test('preserved: update.mjs --install takes a folder not created yet and one under a linked parent', () =>
  withTemp(async (dir) => {
    const release = await releases(dir, newPair())('1.0.0');
    const real = join(dir, 'real-parent');
    await mkdir(real);
    await makeState(join(real, 'copy'));
    symlinkSync(real, join(dir, 'parent-link'));
    for (const [name, given, recorded] of [
      ['root-new', join(dir, 'not-yet'), join(dir, 'not-yet')],
      ['root-parent', join(dir, 'parent-link', 'copy'), join(real, 'copy')],
    ]) {
      const root = join(dir, name);
      const result = installWith(dir, root, release, given);
      assert.equal(result.status, 0, `${given}: ${result.stderr}`);
      assert.match(result.stdout, /^Installed 1\.0\.0$/m);
      const install = JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'));
      assert.equal(install.stateDir, recorded, given);
    }
  }));
