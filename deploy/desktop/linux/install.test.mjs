// deploy/desktop/linux/install.sh while an update is pending or halted: it stops before it creates
// anything, in both modes. Runs the real script in a temporary HOME with fake curl, pnpm and npm
// (nothing is fetched, built or probed on a port) and synthetic data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeState, newPair, releases, snapshot, withTemp } from '../updater/verifier-helpers.mjs';

const installer = join(dirname(fileURLToPath(import.meta.url)), 'install.sh');
const REAL = ['cat', 'chmod', 'cp', 'cut', 'dirname', 'mkdir', 'openssl', 'readlink', 'sh', 'tr'];

/** A temporary HOME whose PATH has only the real tools above, the real Node and logging fakes. */
async function sandbox(dir) {
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const calls = join(dir, 'calls');
  await mkdir(bin);
  await mkdir(home);
  for (const name of REAL) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    assert.equal(found.status, 0, `${name} is needed by this test`);
    symlinkSync(found.stdout.trim(), join(bin, name));
  }
  const fake = (name, body) =>
    writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${calls}'\n${body}\n`, {
      mode: 0o755,
    });
  await fake('node', `exec '${process.execPath}' "$@"`);
  await fake('curl', 'exit 22'); // nothing answers: no port is ever probed
  await fake('pnpm', 'echo 12.11.2');
  await fake('npm', 'exit 0');
  const data = join(home, '.local/share');
  const appRoot = join(data, 'sipges-app');
  const state = join(data, 'sipges-local');
  const env = { HOME: home, XDG_DATA_HOME: data, PATH: bin, SIPGES_DESKTOP_PORT: '1' };
  const exec = (args, extra = {}) => {
    const result = spawnSync(join(bin, 'sh'), [installer, ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
    return { ...result, log: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
  };
  return { home, data, appRoot, state, exec };
}

const pending = (journal) =>
  `SIPGES: hay una actualización de SIPGES pendiente o detenida (${journal}); no se cambió nada. No borres ni muevas ninguna carpeta de SIPGES. Abre SIPGES desde su lanzador para que termine de recuperarla; si dice que no se inició, sigue «Si una actualización se detiene a medias» en deploy/desktop/README.es.md.\n`;

for (const [mode, args] of [
  ['managed', (release) => ['--managed', release]],
  ['clone', () => []],
])
  test(`install.sh in ${mode} mode stops with exit 1 and creates nothing while an update journal exists`, () =>
    withTemp(async (dir) => {
      const s = await sandbox(dir);
      const release = await releases(dir, newPair())('1.0.0');
      // A halted restore: the state folder is missing until --recover puts its copy back.
      await mkdir(s.appRoot, { recursive: true });
      const journal = join(s.appRoot, 'update-journal.json');
      await writeFile(journal, '{"phase":"restoring","synthetic":true}\n');
      await writeFile(join(s.appRoot, 'install.json'), `{"format":1,"stateDir":"${s.state}"}\n`);
      const before = await snapshot(s.home);

      const result = s.exec(args(release));
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, pending(journal));
      assert.equal(result.log, '', 'no tool was run: nothing probed, installed or built');
      assert.equal(existsSync(s.state), false, 'no state folder was created');
      assert.deepEqual(await snapshot(s.home), before, 'nothing in HOME changed');
      assert.deepEqual(readdirSync(s.data), ['sipges-app']);
    }));

test('preserved: install.sh --managed with no journal still installs and prepares the state', () =>
  withTemp(async (dir) => {
    const s = await sandbox(dir);
    const release = await releases(dir, newPair())('1.0.0');
    const result = s.exec(['--managed', release]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^SIPGES is installed\. Open it from the application launcher\.$/m);
    const current = JSON.parse(readFileSync(join(s.appRoot, 'current.json'), 'utf8'));
    assert.deepEqual([current.version, current.path], ['1.0.0', 'versions/1.0.0']);
    assert.deepEqual(readdirSync(s.state).sort(), [
      'admin-password',
      'data-key',
      'pglite',
      'uploads',
    ]);
    assert.equal(existsSync(join(s.appRoot, 'update-journal.json')), false);
    assert.ok(existsSync(join(s.data, 'applications/sipges.desktop')));
  }));

test('install.sh --managed refuses a SIPGES_DESKTOP_STATE that is a link or leads to the original', () =>
  withTemp(async (dir) => {
    const s = await sandbox(dir);
    const release = await releases(dir, newPair())('1.0.0');
    // The original data folder at its default place; the copy the data move makes beside it.
    await makeState(s.state);
    const copy = join(s.data, 'sipges-datos');
    await makeState(copy);
    const link = join(dir, 'enlace');
    symlinkSync(s.state, link);
    const parent = join(dir, 'share-link');
    symlinkSync(s.data, parent);
    const before = await snapshot(s.home);
    const linkLine = (state) =>
      `SIPGES: la carpeta de datos ${state} es un enlace: pasa en SIPGES_DESKTOP_STATE la carpeta real de la copia, nunca un enlace a ella; no se cambió nada.\n`;
    const originalLine = (state) =>
      `SIPGES: SIPGES_DESKTOP_STATE=${state} lleva a la carpeta de datos original ${s.state}: pasa la carpeta real de la copia, nunca la original ni un enlace a ella; no se cambió nada.\n`;
    for (const [state, stderr] of [
      [link, linkLine(link)],
      [`${link}/`, linkLine(`${link}/`)],
      [join(parent, 'sipges-local'), originalLine(join(parent, 'sipges-local'))],
      [s.state, originalLine(s.state)],
    ]) {
      const result = s.exec(['--managed', release], { SIPGES_DESKTOP_STATE: state });
      assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', stderr], state);
      assert.doesNotMatch(result.log, /update\.mjs/, 'the updater was not run');
      assert.deepEqual(await snapshot(s.home), before, 'nothing in HOME changed');
    }
    // Preserved: the real folder of the copy still installs, and is the one recorded.
    const result = s.exec(['--managed', release], { SIPGES_DESKTOP_STATE: copy });
    assert.equal(result.status, 0, result.stderr);
    const recorded = JSON.parse(readFileSync(join(s.appRoot, 'install.json'), 'utf8'));
    assert.equal(recorded.stateDir, copy);
  }));
