// Edges of the process id file builder.mjs keeps while it builds (.sipges-package-building) and
// that clearFailedPackage (deploy/desktop/windows/visit-kit.mjs) reads before removing a failed
// build: only exactly `<pid>\n` of a process that no longer runs lets it remove anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeCheckout, treeOf } from './builder-helpers.mjs';
import { withTemp } from '../updater/verifier-helpers.mjs';
import { createRelease } from '../updater/release.mjs';
import { clearFailedPackage } from '../windows/visit-kit.mjs';

const BUILDING = '.sipges-package-building';
const PACKAGE = '.data/desktop-packages/sipges-1.0.0';

/** Whether signal 0 says no process has this id. */
const dead = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
};

/** A checkout under `dir` with a failed build of 1.0.0; its builder ended, so its id is dead. */
async function failedBuild(dir) {
  const root = join(dir, 'repo');
  const { build } = await fakeCheckout(root);
  assert.equal(build('1.0.0', { failWebBuild: true }).status, 1);
  const out = join(root, PACKAGE);
  const text = await readFile(join(out, BUILDING), 'utf8');
  assert.match(text, /^[1-9]\d*\n$/);
  const pid = Number(text);
  assert.ok(dead(pid), `the ended builder ${pid} no longer runs`);
  return { root, out, pid };
}

/** A refusal of the in-progress kind that names the way out, with nothing removed. */
function assertRefused(result, out, label) {
  assert.equal(result.removed, null, label);
  assert.match(result.refusal, /^Hay otra construcción de la versión 1\.0\.0 en curso/, label);
  assert.ok(result.refusal.includes(`borrá esa carpeta (solo ${out})`), label);
}

test('a process id file that is not exactly <pid>\\n is refused; the same dead id written so is removed', () =>
  withTemp(async (dir) => {
    const { root, out, pid } = await failedBuild(dir);
    const id = join(out, BUILDING);
    const cases = {
      'no newline': `${pid}`,
      'CRLF': `${pid}\r\n`,
      'double newline': `${pid}\n\n`,
      'leading space': ` ${pid}\n`,
      'trailing space': `${pid} \n`,
      'leading zero': `0${pid}\n`,
      zero: '0\n',
      negative: '-1\n',
      empty: '',
      hexadecimal: '0x10\n',
      exponent: '1e3\n',
      'past 32 bits': '4294967297\n',
      'past a double': '99999999999999999999\n',
    };
    for (const [label, text] of Object.entries(cases)) {
      await writeFile(id, text);
      const before = await treeOf(dir);
      assertRefused(await clearFailedPackage({ checkout: root, version: '1.0.0' }), out, label);
      assert.deepEqual(await treeOf(dir), before, label);
    }
    await writeFile(id, `${pid}\n`);
    assert.deepEqual(await clearFailedPackage({ checkout: root, version: '1.0.0' }), {
      removed: out,
      refusal: null,
    });
    assert.equal(existsSync(out), false);
  }));

test('a process id file that is a link or a folder is refused and its target is untouched', async (t) => {
  // A file link needs a privilege on Windows; a folder link is a junction there.
  const kinds = ['folder', 'link to a folder'];
  if (process.platform !== 'win32') kinds.push('link to a file');
  else t.diagnostic('link to a file not tried on Windows: creating it needs a privilege');
  for (const kind of kinds)
    await withTemp(async (dir) => {
      const { root, out, pid } = await failedBuild(dir);
      const id = join(out, BUILDING);
      await unlink(id);
      const outside = join(dir, 'outside');
      await mkdir(outside);
      // A removable id behind the link: only its kind may refuse it.
      await writeFile(join(outside, 'id'), `${pid}\n`);
      if (kind === 'folder') {
        await mkdir(id);
        await writeFile(join(id, 'inside.txt'), 'synthetic');
      } else if (kind === 'link to a folder') await symlink(outside, id, 'junction');
      else await symlink(join(outside, 'id'), id);
      const before = await treeOf(dir);
      assertRefused(await clearFailedPackage({ checkout: root, version: '1.0.0' }), out, kind);
      assert.deepEqual(await treeOf(dir), before, kind);
      assert.equal(await readFile(join(outside, 'id'), 'utf8'), `${pid}\n`, kind);
    });
});

const signalOne = () => {
  try {
    process.kill(1, 0);
    return 'alive';
  } catch (error) {
    return error.code;
  }
};

test('a process the kit may not signal (EPERM, pid 1 as a normal user) counts as alive', {
  skip:
    process.platform === 'win32' || process.getuid?.() === 0 || signalOne() !== 'EPERM'
      ? 'needs POSIX as a normal user, where signalling pid 1 answers EPERM'
      : false,
}, () =>
  withTemp(async (dir) => {
    const { root, out } = await failedBuild(dir);
    await writeFile(join(out, BUILDING), '1\n');
    const before = await treeOf(dir);
    assertRefused(await clearFailedPackage({ checkout: root, version: '1.0.0' }), out, 'pid 1');
    assert.deepEqual(await treeOf(dir), before);
  }));

test('a finished build holds no process id file, and a release signed from it lists none', () =>
  withTemp(async (dir) => {
    const root = join(dir, 'repo');
    const { build } = await fakeCheckout(root);
    const built = build('1.0.0');
    assert.equal(built.status, 0, built.stderr);
    const out = join(root, PACKAGE);
    assert.equal(existsSync(join(out, BUILDING)), false);
    const manifest = await createRelease({
      packageDir: out,
      releaseDir: join(dir, 'release-1.0.0'),
      privateKey: generateKeyPairSync('ed25519').privateKey,
    });
    assert.equal(manifest.version, '1.0.0');
    const listed = [...Object.keys(manifest.files), ...Object.keys(manifest.links), ...manifest.directories];
    assert.ok(listed.includes('.sipges-package-complete'), 'the release lists the package files');
    assert.deepEqual(listed.filter((path) => path.split('/').includes(BUILDING)), []);
    assert.equal(existsSync(join(dir, 'release-1.0.0', 'package', BUILDING)), false);
  }));
