// deploy/desktop/linux/install.sh while an update is pending or halted: it stops before it creates
// anything, in both modes. Runs the real script in a temporary HOME with fake curl, pnpm and npm
// (nothing is fetched, built or probed on a port) and synthetic data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyFingerprint } from '../updater/release.mjs';
import { makePackage, makeState, newPair, publicPem, releases, snapshot, withTemp } from '../updater/verifier-helpers.mjs';

const installer = join(dirname(fileURLToPath(import.meta.url)), 'install.sh');
const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL = ['cat', 'chmod', 'cp', 'cut', 'dirname', 'mkdir', 'openssl', 'readlink', 'sed', 'sh', 'tr'];

/** A temporary HOME whose PATH has only the real tools above, the real Node and logging fakes. */
async function sandbox(dir, { withoutNode = false, script = installer } = {}) {
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
  if (!withoutNode) await fake('node', `exec '${process.execPath}' "$@"`);
  await fake('curl', 'exit 22'); // nothing answers: no port is ever probed
  await fake('pnpm', 'echo 12.11.2');
  await fake('npm', 'exit 0');
  const data = join(home, '.local/share');
  const appRoot = join(data, 'sipges-app');
  const state = join(data, 'sipges-local');
  const env = { HOME: home, XDG_DATA_HOME: data, PATH: bin, SIPGES_DESKTOP_PORT: '1' };
  const exec = (args, extra = {}) => {
    const result = spawnSync(join(bin, 'sh'), [script, ...args], {
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

const linkLine = (state) =>
  `SIPGES: la carpeta de datos ${state} es un enlace: pasa en SIPGES_DESKTOP_STATE la carpeta real de la copia, nunca un enlace a ella; no se cambió nada.\n`;

test('install.sh --managed refuses every spelling of a link to the copy before it creates anything', () =>
  withTemp(async (dir) => {
    const s = await sandbox(dir);
    const release = await releases(dir, newPair())('1.0.0');
    // A link to a folder that is NOT the original: only the link check can refuse it.
    const copy = join(s.data, 'sipges-datos');
    await makeState(copy);
    const link = join(dir, 'enlace');
    symlinkSync(copy, link);
    const before = await snapshot(s.home);
    for (const state of [`${link}//`, `${link}/.`, `${link}/./`, `${link}/sub/..`]) {
      const result = s.exec(['--managed', release], { SIPGES_DESKTOP_STATE: state });
      assert.equal(existsSync(s.appRoot), false, `the install root was not created: ${state}`);
      assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', linkLine(state)], state);
      assert.doesNotMatch(result.log, /update\.mjs/, 'the updater was not run');
      assert.deepEqual(await snapshot(s.home), before, 'nothing in HOME changed');
    }
  }));

test('install.sh --managed rerun accepts the original folder the install itself recorded', () =>
  withTemp(async (dir) => {
    const s = await sandbox(dir);
    const release = await releases(dir, newPair())('1.0.0');
    await makeState(s.state);
    // Installed in place, without SIPGES_DESKTOP_STATE: the original folder is the recorded one.
    const first = s.exec(['--managed', release]);
    assert.equal(first.status, 0, first.stderr);
    const recorded = JSON.parse(readFileSync(join(s.appRoot, 'install.json'), 'utf8'));
    assert.equal(recorded.stateDir, s.state);
    const result = s.exec(['--managed', release], { SIPGES_DESKTOP_STATE: s.state });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^SIPGES is already installed: 1\.0\.0\./m);
  }));

test('install.sh --managed rerun on a recorded copy refuses a link to it and the original folder', () =>
  withTemp(async (dir) => {
    const s = await sandbox(dir);
    const release = await releases(dir, newPair())('1.0.0');
    await makeState(s.state);
    const copy = join(s.data, 'sipges-datos');
    await makeState(copy);
    const first = s.exec(['--managed', release], { SIPGES_DESKTOP_STATE: copy });
    assert.equal(first.status, 0, first.stderr);
    const link = join(dir, 'enlace-copia');
    symlinkSync(copy, link);
    const before = await snapshot(s.home);
    const recordedLine = (state) =>
      `SIPGES: esta instalación usa la carpeta de datos ${copy}, no ${state}: vuelve a ejecutar el script sin SIPGES_DESKTOP_STATE o con SIPGES_DESKTOP_STATE=${copy}; no se cambió nada.\n`;
    for (const [state, stderr] of [
      [link, linkLine(link)],
      [s.state, recordedLine(s.state)],
    ]) {
      const result = s.exec(['--managed', release], { SIPGES_DESKTOP_STATE: state });
      assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', stderr], state);
      assert.deepEqual(await snapshot(s.home), before, 'nothing in HOME changed');
    }
  }));

// go-rust-stack T72d3: a release built with --go is installed WITHOUT Node by a trusted
// sipges-desktop that the kit carries (deploy/desktop/bin, built from the trusted checkout),
// never by the binary inside the release being installed (which could verify itself).
const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const hasGo = spawnSync('go', ['version']).status === 0;

/** A copy of deploy/desktop as the kit unpacks it, with the trusted installer when given. */
function kit(dir, trusted) {
  const desktop = join(dir, 'kit', 'deploy', 'desktop');
  cpSync(desktopDir, desktop, { recursive: true, filter: (from) => !from.includes(`${join('desktop', 'bin')}`) });
  if (trusted) {
    mkdirSync(join(desktop, 'bin'), { recursive: true });
    copyFileSync(trusted, join(desktop, 'bin', 'sipges-desktop'));
    chmodSync(join(desktop, 'bin', 'sipges-desktop'), 0o755);
  }
  return join(desktop, 'linux', 'install.sh');
}

/** A release binary that leaves a mark when anything runs it. */
const tattletale = (mark) => `#!/bin/sh\necho ran >> '${mark}'\nexit 0\n`;

let built;
function trustedBinary() {
  if (built) return built;
  const out = mkdtempSync(join(tmpdir(), 'sipges-desktop-build-'));
  const exe = join(out, 'sipges-desktop');
  const result = spawnSync('go', ['build', '-o', exe, './cmd/sipges-desktop'], { cwd: join(repo, 'apps/api-go'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  process.on('exit', () => rmSync(out, { recursive: true, force: true }));
  built = exe;
  return exe;
}

test('install.sh --managed installs a Go release with the kit\'s trusted sipges-desktop, without Node, never running the release\'s own', { skip: !hasGo && 'needs the go toolchain' }, () =>
  withTemp(async (dir) => {
    const mark = join(dir, 'release-binary-ran');
    const s = await sandbox(dir, { withoutNode: true, script: kit(dir, trustedBinary()) });
    const pair = newPair();
    const release = await releases(dir, pair, {
      make: async (pkg, version) => {
        await makePackage(pkg, version);
        await mkdir(join(pkg, 'go'), { recursive: true });
        await writeFile(join(pkg, 'go', 'sipges-desktop'), tattletale(mark), { mode: 0o755 });
      },
    })('1.0.0');
    const result = s.exec(['--managed', release]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.stdout.startsWith(`Trusting the update key that signed this release (SHA-256 ${keyFingerprint(pair.publicKey)}).\nInstalled 1.0.0\n`),
      result.stdout,
    );
    assert.equal(existsSync(mark), false, 'the release\'s own sipges-desktop never ran');
    assert.doesNotMatch(result.log, /^node /m, 'node was never run');
    const current = JSON.parse(readFileSync(join(s.appRoot, 'current.json'), 'utf8'));
    assert.deepEqual([current.version, current.path], ['1.0.0', 'versions/1.0.0']);
    assert.equal(JSON.parse(readFileSync(join(s.appRoot, 'install.json'), 'utf8')).stateDir, s.state);
    assert.deepEqual(readdirSync(s.state).sort(), ['admin-password', 'data-key', 'pglite', 'uploads']);
    // A rerun reads the installed version without Node and keeps it.
    const rerun = s.exec(['--managed', release]);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /^SIPGES is already installed: 1\.0\.0\. /m);
  }));

// The verifier's probe: an unsigned manifest, a garbage signature and a script as the binary.
test('install.sh --managed refuses a tampered Go release and never runs its binary', { skip: !hasGo && 'needs the go toolchain' }, () =>
  withTemp(async (dir) => {
    const mark = join(dir, 'release-binary-ran');
    const s = await sandbox(dir, { withoutNode: true, script: kit(dir, trustedBinary()) });
    const release = join(dir, 'release-tampered');
    await makePackage(join(release, 'package'), '1.0.0');
    await mkdir(join(release, 'package', 'go'), { recursive: true });
    await writeFile(join(release, 'package', 'go', 'sipges-desktop'), tattletale(mark), { mode: 0o755 });
    await writeFile(join(release, 'package', 'update-public-key.pem'), publicPem(newPair()));
    await writeFile(join(release, 'release.json'), '{"format":1,"version":"1.0.0"}\n');
    await writeFile(join(release, 'release.sig'), 'not a signature\n');
    const result = s.exec(['--managed', release]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /the signed release could not be installed/);
    assert.equal(existsSync(mark), false, 'the tampered release\'s binary never ran');
    assert.equal(existsSync(join(s.appRoot, 'current.json')), false, 'nothing was installed');
    assert.equal(existsSync(s.state), false, 'no state folder was created');
  }));

test('install.sh --managed refuses a Go release when the kit carries no trusted sipges-desktop', () =>
  withTemp(async (dir) => {
    const mark = join(dir, 'release-binary-ran');
    const s = await sandbox(dir, { withoutNode: true, script: kit(dir, null) });
    const release = await releases(dir, newPair(), {
      make: async (pkg, version) => {
        await makePackage(pkg, version);
        await mkdir(join(pkg, 'go'), { recursive: true });
        await writeFile(join(pkg, 'go', 'sipges-desktop'), tattletale(mark), { mode: 0o755 });
      },
    })('1.0.0');
    const result = s.exec(['--managed', release]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^SIPGES: this kit has no trusted sipges-desktop \(.*\/deploy\/desktop\/bin\/sipges-desktop\): build it from the trusted checkout and run this script again; nothing was changed\.\n$/);
    assert.equal(existsSync(mark), false, 'the release\'s binary never ran');
    assert.equal(existsSync(s.appRoot), false, 'nothing was created');
  }));

test('install.sh --managed asks for Node only for a release without the Go mode', () =>
  withTemp(async (dir) => {
    const s = await sandbox(dir, { withoutNode: true });
    const release = await releases(dir, newPair())('1.0.0');
    const result = s.exec(['--managed', release]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'SIPGES: Node.js 24 or later is required: install it and run this script again.\n');
    assert.equal(existsSync(s.appRoot), false, 'nothing was created');
  }));
