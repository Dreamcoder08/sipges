import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fakeCheckout, treeOf } from './builder-helpers.mjs';
import { withTemp } from '../updater/verifier-helpers.mjs';
import { clearFailedPackage } from '../windows/visit-kit.mjs';

// A marker without a completion file also describes a build that is still running.
test('cleanup refuses a build in progress and leaves it able to finish', () =>
  withTemp(async (dir) => {
    const root = join(dir, 'checkout with spaces');
    const { env } = await fakeCheckout(root);
    const reached = join(dir, 'reached');
    const resume = join(dir, 'resume');
    const shim = join(`${root}-bin`, 'pnpm');
    await writeFile(
      shim,
      (await readFile(shim, 'utf8')).replace(
        'const args = process.argv.slice(2);',
        `const args = process.argv.slice(2);
if (args.includes('build')) {
  writeFileSync(${JSON.stringify(reached)}, 'ready');
  while (!require('node:fs').existsSync(${JSON.stringify(resume)}))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}`,
      ),
    );
    const out = join(root, '.data/desktop-packages/sipges-1.0.0');
    const child = spawn(
      process.execPath,
      [join(root, 'deploy/desktop/package/builder.mjs'), '--version', '1.0.0', '--out', out],
      { cwd: root, env: env(), timeout: 20000, stdio: 'ignore' },
    );
    const ended = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    try {
      for (let n = 0; n < 500 && !existsSync(reached); n++) await sleep(10);
      assert.ok(existsSync(reached), 'builder reached its web build');
      const before = await treeOf(out);
      const result = await clearFailedPackage({ checkout: root, version: '1.0.0' });
      assert.equal(result.removed, null);
      assert.match(result.refusal, /^Hay otra construcción de la versión 1\.0\.0 en curso/);
      assert.deepEqual(await treeOf(out), before);
    } finally {
      await writeFile(resume, 'continue');
      assert.equal(await ended, 0, 'the first build must still finish');
    }
    // Finished: the process id file is gone and the package is refused as finished.
    assert.equal(existsSync(join(out, '.sipges-package-building')), false);
    const after = await clearFailedPackage({ checkout: root, version: '1.0.0' });
    assert.match(after.refusal, /^Ya hay un paquete terminado/);
  }));

test('a failed build whose builder ended is still removed', () =>
  withTemp(async (dir) => {
    const root = join(dir, 'repo');
    const { build } = await fakeCheckout(root);
    assert.notEqual(build('1.0.0', { failWebBuild: true }).status, 0);
    const out = join(root, '.data/desktop-packages/sipges-1.0.0');
    assert.match(await readFile(join(out, '.sipges-package-building'), 'utf8'), /^\d+\n$/);
    assert.deepEqual(await clearFailedPackage({ checkout: root, version: '1.0.0' }), { removed: out, refusal: null });
  }));

test('a process id file that cannot be read as one is refused, nothing removed', () =>
  withTemp(async (dir) => {
    const root = join(dir, 'repo');
    const { build } = await fakeCheckout(root);
    assert.notEqual(build('1.0.0', { failWebBuild: true }).status, 0);
    const out = join(root, '.data/desktop-packages/sipges-1.0.0');
    await writeFile(join(out, '.sipges-package-building'), 'not a number\n');
    const before = await treeOf(out);
    const result = await clearFailedPackage({ checkout: root, version: '1.0.0' });
    assert.equal(result.removed, null);
    assert.ok(result.refusal);
    assert.deepEqual(await treeOf(out), before);
  }));
