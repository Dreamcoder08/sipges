// The Go mode of sipges-managed.sh (go-rust-stack T72c, T72d3): run for real on a scratch install
// root whose sipges-desktop is a stand-in that records what it was given. The launcher entry
// starts the Go launcher when the version has it and the data are in pg18 (or there are none
// yet), and run-current.mjs while the data are only in PGlite; --go refuses, before starting
// anything, a version without the Go mode and data not moved yet. Synthetic folders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'sipges-managed.sh');
const NOT_MOVED = 'SIPGES no se inició en modo Go: sus datos todavía no se movieron a PostgreSQL. No se tocó nada. Abra SIPGES desde su acceso directo habitual.';
const MISSING = 'Esta versión de SIPGES no incluye el modo Go. Abra SIPGES desde su acceso directo habitual.';

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

/** An install root with current.json, install.json and a version whose Go files are stand-ins. */
function installRoot({ go = true, bundle = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sipges-go-mode-'));
  const root = join(dir, 'app');
  const state = join(dir, 'state');
  const version = join(root, 'versions', '1.0.0');
  mkdirSync(join(version, 'web'), { recursive: true });
  mkdirSync(join(state, 'pglite'), { recursive: true });
  writeFileSync(join(root, 'current.json'), JSON.stringify({ version: '1.0.0', path: 'versions/1.0.0' }));
  writeFileSync(join(root, 'install.json'), JSON.stringify({ stateDir: state }));
  writeFileSync(join(root, 'sipges-desktop.sh'), readFileSync(SCRIPT));
  chmodSync(join(root, 'sipges-desktop.sh'), 0o755);
  // run-current.mjs stand-in: the TypeScript path, recorded the same way.
  writeFileSync(join(root, 'run-current.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, 'ran'))}, 'typescript ' + process.argv.slice(2).join(' '));\nprocess.exit(1);\n`);
  if (go) {
    mkdirSync(join(version, 'go'), { recursive: true });
    const record = join(dir, 'ran');
    writeFileSync(
      join(version, 'go', 'sipges-desktop'),
      `#!/bin/sh\nprintf 'go %s\\npgbin=%s\\n' "$*" "$SIPGES_PG_BIN" > ${JSON.stringify(record)}\nexit 1\n`,
      { mode: 0o755 },
    );
  }
  if (bundle) {
    mkdirSync(join(version, 'postgresql', 'bin'), { recursive: true });
    writeFileSync(join(version, 'postgresql', 'bin', 'pg_ctl'), '', { mode: 0o755 });
  }
  return { dir, root, state, version, ran: join(dir, 'ran') };
}

const launch = async (root, args, extraEnv = {}) =>
  spawnSync('sh', [join(root, 'sipges-desktop.sh'), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SIPGES_DESKTOP_PORT: String(await freePort()), SIPGES_DESKTOP_WAIT: '5', ...extraEnv },
  });

test('data only in PGlite start run-current.mjs, as before', async () => {
  const { dir, root, state, ran } = installRoot();
  try {
    writeFileSync(join(state, 'pglite', 'PG_VERSION'), '17\n');
    const result = await launch(root, []);
    assert.equal(result.status, 1);
    assert.match(readFileSync(ran, 'utf8'), /^typescript --releases .*\/releases --port \d+$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a version without the Go mode starts run-current.mjs, as before', async () => {
  const { dir, root, ran } = installRoot({ go: false });
  try {
    assert.equal((await launch(root, [])).status, 1);
    assert.match(readFileSync(ran, 'utf8'), /^typescript /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, setup] of [
  ['data in pg18', (state) => {
    writeFileSync(join(state, 'pglite', 'PG_VERSION'), '17\n');
    mkdirSync(join(state, 'pg18'));
    writeFileSync(join(state, 'pg18', 'PG_VERSION'), '18\n');
  }],
  ['a new install (no data yet)', () => {}],
]) {
  test(`${name}: the launcher entry starts the Go launcher of the install, with its update folder and bundle`, async () => {
    const { dir, root, state, version, ran } = installRoot();
    try {
      setup(state);
      const port = await freePort();
      const result = spawnSync('sh', [join(root, 'sipges-desktop.sh')], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SIPGES_DESKTOP_PORT: String(port), SIPGES_DESKTOP_WAIT: '5' },
      });
      assert.equal(result.status, 1, 'the stand-in exits 1: «stopped while starting»');
      assert.equal(
        readFileSync(ran, 'utf8'),
        `go --install ${root} --releases ${join(root, 'releases')} --port ${port}\npgbin=${join(version, 'postgresql', 'bin')}\n`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('the Go launcher starts without Node on the PATH, from indented install files', { skip: process.platform === 'win32' && 'POSIX sh' }, async () => {
  const { dir, root, state, ran } = installRoot();
  try {
    writeFileSync(join(root, 'current.json'), `${JSON.stringify({ format: 1, version: '1.0.0', path: 'versions/1.0.0', adopted: false }, null, 2)}\n`);
    writeFileSync(join(root, 'install.json'), `${JSON.stringify({ stateDir: state }, null, 2)}\n`);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const tool of ['sh', 'dirname', 'readlink', 'tr', 'sed', 'ls', 'curl', 'sleep', 'cat', 'head', 'basename', 'ss', 'nohup']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (found) symlinkSync(found, join(bin, tool));
    }
    assert.equal(existsSync(join(bin, 'node')), false);
    const result = await launch(root, [], { PATH: bin });
    assert.equal(result.status, 1, result.stderr);
    assert.match(readFileSync(ran, 'utf8'), /^go --install /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--go without a bundle uses SIPGES_PG_BIN, and refuses when neither is there', async () => {
  const { dir, root, ran } = installRoot({ bundle: false });
  try {
    const refused = await launch(root, ['--go']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /No se encontró PostgreSQL 18 para el modo Go: indique la carpeta bin de PostgreSQL 18 en SIPGES_PG_BIN\./);
    assert.equal(existsSync(ran), false);
    const given = await launch(root, ['--go'], { SIPGES_PG_BIN: '/opt/pg18/bin' });
    assert.equal(given.status, 1);
    assert.match(readFileSync(ran, 'utf8'), /^pgbin=\/opt\/pg18\/bin$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--go refuses, starting nothing, a version without the Go mode and data not moved yet', async () => {
  const missing = installRoot({ go: false });
  try {
    const result = await launch(missing.root, ['--go']);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(MISSING), result.stderr);
    assert.equal(existsSync(missing.ran), false);
  } finally {
    rmSync(missing.dir, { recursive: true, force: true });
  }
  const notMoved = installRoot();
  try {
    writeFileSync(join(notMoved.state, 'pglite', 'PG_VERSION'), '18\n');
    const result = await launch(notMoved.root, ['--go']);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(NOT_MOVED), result.stderr);
    assert.equal(existsSync(notMoved.ran), false);
    assert.equal(existsSync(join(notMoved.state, 'pg18')), false);
    // Once pg18 holds a cluster, the same state folder starts.
    mkdirSync(join(notMoved.state, 'pg18'));
    writeFileSync(join(notMoved.state, 'pg18', 'PG_VERSION'), '18\n');
    assert.equal((await launch(notMoved.root, ['--go'])).status, 1);
    assert.match(readFileSync(notMoved.ran, 'utf8'), /^go --install .* --port \d+$/m);
  } finally {
    rmSync(notMoved.dir, { recursive: true, force: true });
  }
});

// Review R4: a running SIPGES is reused only in the mode asked for. A real listener answers
// /health on the port, as node (the TypeScript API) or as a program named api (the Go API).
const OPEN_NOT_GO = 'SIPGES ya está abierto sin el modo Go. Ciérrelo antes de abrirlo en modo Go.';
const OPEN_GO = 'SIPGES ya está abierto en modo Go. Ciérrelo antes de abrirlo sin el modo Go.';

async function serving(image, dir) {
  const { spawn } = await import('node:child_process');
  const { symlinkSync } = await import('node:fs');
  const port = await freePort();
  const exe = join(dir, image);
  if (!existsSync(exe)) symlinkSync(process.execPath, exe);
  const child = spawn(exe, ['-e', `require('node:http').createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1', () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((done) => child.stdout.once('data', done));
  return { port, stop: () => child.kill() };
}

test('the Go mode refuses to reuse a TypeScript SIPGES; the TypeScript mode refuses to reuse a Go one', { skip: process.platform !== 'linux' && 'ss names the listener on Linux' }, async () => {
  const { dir, root, state, ran } = installRoot();
  const env = (port) => ({ PATH: process.env.PATH, HOME: process.env.HOME, SIPGES_DESKTOP_PORT: String(port), SIPGES_DESKTOP_WAIT: '5' });
  const ts = await serving('node', dir);
  try {
    const result = spawnSync('sh', [join(root, 'sipges-desktop.sh'), '--go'], { encoding: 'utf8', env: env(ts.port) });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(OPEN_NOT_GO), result.stderr);
    assert.equal(existsSync(ran), false, 'nothing was started');
  } finally {
    ts.stop();
  }
  // Data only in PGlite: the TypeScript mode.
  writeFileSync(join(state, 'pglite', 'PG_VERSION'), '17\n');
  const go = await serving('api', dir);
  try {
    const result = spawnSync('sh', [join(root, 'sipges-desktop.sh')], { encoding: 'utf8', env: env(go.port) });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(OPEN_GO), result.stderr);
    assert.equal(existsSync(ran), false, 'nothing was started');
  } finally {
    go.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review C1: a cluster --prepare-only made and the move has not filled (pg18.pending-move beside
// it) is "not moved": the shortcut stays on TypeScript and --go refuses, starting nothing.
test('a prepared cluster waiting for the move keeps the TypeScript launcher; --go refuses it', async () => {
  const { dir, root, state, ran } = installRoot();
  try {
    writeFileSync(join(state, 'pglite', 'PG_VERSION'), '17\n');
    mkdirSync(join(state, 'pg18'));
    writeFileSync(join(state, 'pg18', 'PG_VERSION'), '18\n');
    writeFileSync(join(state, 'pg18.pending-move'), '');
    const refused = await launch(root, ['--go']);
    assert.equal(refused.status, 1);
    assert.ok(refused.stderr.includes(NOT_MOVED), refused.stderr);
    assert.equal(existsSync(ran), false, 'nothing was started');
    assert.equal((await launch(root, [])).status, 1);
    assert.match(readFileSync(ran, 'utf8'), /^typescript --releases /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
