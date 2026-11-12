// The stable entry the installers copy into the install root (`run-current.mjs`): shortcuts
// point at it, so it must start the current version before and after an update and pass on the
// launcher's exit code. Synthetic packages carry a copy of this updater folder, as built ones do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRelease } from './release.mjs';
import { install, update } from './updater.mjs';
import { freePort } from './boot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RUNTIME = ['boot.mjs', 'launcher.mjs', 'release.mjs', 'update.mjs', 'updater.mjs'];
const NOTICE =
  /^SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar\. No borre nada\. Restaure la copia de seguridad .+ o contacte con soporte\.\n/;

const APP = (version) => `import { createServer } from 'node:http';
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/about') return res.end(JSON.stringify({ version: '${version}' }));
  res.statusCode = 404;
  res.end('{}');
});
server.listen(Number(process.env.SIPGES_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-run-current-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function fixture(dir, options = {}) {
  const pair = generateKeyPairSync('ed25519');
  let serial = 0;
  const releaseOf = async (version, start = APP(version)) => {
    serial += 1;
    const pkg = join(dir, `package-${serial}`);
    const metadata = { version, platform: process.platform, arch: process.arch };
    await put(join(pkg, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    await put(join(pkg, 'start.mjs'), start);
    await put(join(pkg, 'web/index.html'), '<!doctype html>\n');
    await mkdir(join(pkg, 'updater'));
    for (const name of RUNTIME) await copyFile(join(here, name), join(pkg, 'updater', name));
    const release = join(dir, `release-${serial}`);
    await createRelease({ packageDir: pkg, releaseDir: release, privateKey: pair.privateKey });
    return release;
  };
  const root = join(dir, 'install');
  const state = join(dir, 'state');
  await install({
    root,
    release: await releaseOf('1.0.0', options.start),
    stateDir: state,
    trustKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  });
  // What the installers do: the stable entry lives in the root, outside versions/.
  await copyFile(join(here, 'run-current.mjs'), join(root, 'run-current.mjs'));
  return { root, state, releaseOf };
}

function run(root, args) {
  const child = spawn(process.execPath, [join(root, 'run-current.mjs'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { child, stdout: '', stderr: '' };
  child.stdout.on('data', (d) => (out.stdout += d));
  child.stderr.on('data', (d) => (out.stderr += d));
  out.exit = once(child, 'exit').then(([code]) => code);
  return out;
}

async function about(port) {
  for (let i = 0; i < 400; i += 1) {
    try {
      const res = await globalThis.fetch(`http://127.0.0.1:${port}/about`);
      if (res.ok) return await res.json();
    } catch {
      // Not listening yet.
    }
    await sleep(25);
  }
  throw new Error('the synthetic app never answered');
}

test('the stable entry starts the current version, before and after an update', () =>
  withTemp(async (dir) => {
    const { root, releaseOf } = await fixture(dir);
    for (const expected of ['1.0.0', '1.1.0']) {
      if (expected === '1.1.0')
        await update({
          root,
          release: await releaseOf('1.1.0'),
          migrate: async () => {},
          ready: async () => {},
        });
      const port = await freePort();
      const started = run(root, ['--port', `${port}`]);
      try {
        assert.deepEqual(await about(port), { version: expected });
      } finally {
        started.child.kill('SIGTERM');
      }
      assert.equal(await started.exit, 0, started.stderr);
      const events = started.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).event);
      assert.deepEqual(events, ['started']);
    }
    assert.deepEqual((await readdir(join(root, 'versions'))).sort(), ['1.0.0', '1.1.0']);
  }));

test('the stable entry passes on exit code 3 and the notice of a halted update', () =>
  withTemp(async (dir) => {
    const { root, state, releaseOf } = await fixture(dir);
    await put(join(state, 'pglite', 'PG_VERSION'), '17\n');
    await put(join(state, 'data-key'), 'c3ludGhldGljLWtleS1mb3ItdGVzdHMtb25seS0wMDA=\n');
    await put(join(state, 'admin-password'), 'synthetic-admin-password\n');
    await assert.rejects(
      update({
        root,
        release: await releaseOf('1.1.0'),
        migrate: async ({ stateDir }) => {
          for (const name of await readdir(dirname(stateDir)))
            if (name.includes('.pre-update-'))
              await rm(join(dirname(stateDir), name), { recursive: true });
          throw new Error('synthetic migration failure');
        },
        ready: async () => {},
      }),
      (error) => error.code === 'ROLLBACK_INCOMPLETE',
    );
    const halted = run(root, ['--port', `${await freePort()}`]);
    assert.equal(await halted.exit, 3);
    assert.match(halted.stderr, NOTICE);
  }));

test('the stable entry says in Spanish that nothing is installed', () =>
  withTemp(async (dir) => {
    await mkdir(join(dir, 'empty'));
    await copyFile(join(here, 'run-current.mjs'), join(dir, 'empty', 'run-current.mjs'));
    const nothing = run(join(dir, 'empty'), []);
    assert.equal(await nothing.exit, 1);
    assert.equal(nothing.stdout, '');
    assert.match(
      nothing.stderr,
      /^SIPGES no está instalado en .+empty: falta current\.json\. Vuelva a ejecutar el instalador\.\n$/,
    );
  }));

// A server that does not stop on SIGTERM (a long write, a stuck shutdown), recording its pid.
const STUBBORN = `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
writeFileSync(join(dirname(process.env.SIPGES_PGLITE_DIR), 'server.pid'), String(process.pid));
createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/about') return res.end(JSON.stringify({ version: 'stubborn' }));
  res.statusCode = 404;
  res.end('{}');
}).listen(Number(process.env.SIPGES_PORT), '127.0.0.1');
process.on('SIGTERM', () => {});
`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    return false;
  }
};

for (const signal of ['SIGTERM', 'SIGINT'])
  test(`a second ${signal} during a graceful stop force-stops the server and leaves no process behind`, () =>
    withTemp(async (dir) => {
      const { root, state } = await fixture(dir, { start: STUBBORN });
      const port = await freePort();
      const started = run(root, ['--port', `${port}`]);
      let pid;
      try {
        assert.deepEqual(await about(port), { version: 'stubborn' });
        pid = Number(await readFile(join(state, 'server.pid'), 'utf8'));
        started.child.kill(signal);
        // The first signal starts the graceful stop; the server ignores it.
        await sleep(300);
        assert.equal(alive(pid), true);
        started.child.kill(signal);
        const code = await Promise.race([
          started.exit,
          sleep(5000, undefined, { ref: false }).then(() => 'still running'),
        ]);
        assert.equal(code, 1, started.stderr);
        for (let i = 0; i < 100 && alive(pid); i += 1) await sleep(30);
        assert.equal(alive(pid), false, 'the server outlived the forced stop');
        const events = started.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).event);
        assert.deepEqual(events, ['started', 'stop_forced']);
      } finally {
        started.child.kill('SIGKILL');
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }));
