// Synthetic tests of managed desktop startup and the click-to-update path. The "app" is a tiny
// loopback HTTP server written as each package's start.mjs; migration and readiness of the
// update are injected. Keys, packages, releases and state folders live in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRelease, readRelease, loadPublicKey } from './release.mjs';
import { install, readCurrent } from './updater.mjs';
import { freePort } from './boot.mjs';
import { CHANNEL, launch } from './launcher.mjs';

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-launcher-'));
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

const APP = (version) => `import { createServer } from 'node:http';
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health/ready') return res.end('{"status":"ready"}');
  if (req.url === '/about')
    return res.end(JSON.stringify({ version: '${version}', channel: process.env.SIPGES_DESKTOP_UPDATE_DIR ?? null }));
  res.statusCode = 404;
  res.end('{}');
});
server.listen(Number(process.env.SIPGES_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

async function makePackage(dir, version) {
  const metadata = {
    version,
    platform: process.platform,
    arch: process.arch,
    node: '>=24',
    entry: 'start.mjs',
  };
  await put(join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await put(join(dir, 'start.mjs'), APP(version));
  await put(join(dir, 'web/index.html'), `<!doctype html><title>SIPGES ${version}</title>\n`);
}

let serial = 0;
async function fixture(dir) {
  const pair = generateKeyPairSync('ed25519');
  const root = join(dir, 'install');
  const state = join(dir, 'state');
  const source = join(dir, 'releases');
  await mkdir(source);
  const releaseOf = async (version, options = {}) => {
    serial += 1;
    const pkg = join(dir, `package-${serial}`);
    const release = join(options.parent ?? source, options.name ?? `sipges-${version}-${serial}`);
    await makePackage(pkg, version);
    await createRelease({
      packageDir: pkg,
      releaseDir: release,
      privateKey: options.key ?? pair.privateKey,
      notes: options.notes ?? null,
    });
    return release;
  };
  await install({
    root,
    release: await releaseOf('1.0.0', { parent: dir }),
    stateDir: state,
    trustKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  });
  return { root, state, source, pair, releaseOf };
}

/** Starts the launcher and waits until the synthetic app answers. */
async function started(options) {
  const port = await freePort();
  const lines = [];
  const running = await launch({
    port,
    pollMs: 20,
    log: (event, fields) => lines.push({ event, ...fields }),
    migrate: async () => {},
    ready: async () => {},
    ...options,
  });
  const about = async () => {
    for (let i = 0; i < 200; i += 1) {
      try {
        const res = await globalThis.fetch(`http://127.0.0.1:${port}/about`);
        if (res.ok) return await res.json();
      } catch {
        // Not listening yet, or restarting.
      }
      await sleep(25);
    }
    throw new Error('the synthetic app never answered');
  };
  return { ...running, port, lines, about };
}

const status = async (root) =>
  JSON.parse(await readFile(join(root, CHANNEL, 'status.json'), 'utf8'));
const checks = (lines) => lines.filter((l) => l.event.startsWith('update_check'));
const request = (root, version) =>
  writeFile(join(root, CHANNEL, 'request.json'), JSON.stringify({ format: 1, version }));

test('rule 1: offers the newest correctly signed release and its notes, installing nothing', () =>
  withTemp(async (dir) => {
    const { root, source, releaseOf } = await fixture(dir);
    await releaseOf('1.1.0', { notes: 'Primera mejora.' });
    const newest = await releaseOf('1.2.0', { notes: 'Corrige el filtro.\nNuevo resumen.' });
    const app = await started({ root, source });
    try {
      assert.deepEqual(await app.about(), { version: '1.0.0', channel: join(root, CHANNEL) });
      await app.checked;
      assert.deepEqual(
        { ...(await status(root)), checkedAt: undefined },
        {
          format: 1,
          installed: '1.0.0',
          available: { version: '1.2.0', notes: 'Corrige el filtro.\nNuevo resumen.' },
          checkedAt: undefined,
        },
      );
      assert.deepEqual(checks(app.lines), [
        { event: 'update_check', installed: '1.0.0', available: '1.2.0', skipped: [] },
      ]);
      assert.equal((await readCurrent(root)).version, '1.0.0');
      assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
      assert.deepEqual(await readdir(newest), ['package', 'release.json', 'release.sig']);
    } finally {
      assert.equal(await app.stop(), 0);
    }
  }));

test('rule 5: tampered, foreign-key, older and equal releases are never offered', () =>
  withTemp(async (dir) => {
    const { root, source, releaseOf } = await fixture(dir);
    const tampered = await releaseOf('1.5.0', { notes: 'Original.' });
    const text = await readFile(join(tampered, 'release.json'), 'utf8');
    await writeFile(join(tampered, 'release.json'), text.replace('Original.', 'Cambiado.'));
    await releaseOf('1.6.0', { key: generateKeyPairSync('ed25519').privateKey });
    await releaseOf('0.9.0');
    await releaseOf('1.0.0');
    const app = await started({ root, source });
    try {
      await app.about();
      await app.checked;
      assert.equal((await status(root)).available, null);
      const [line, ...more] = checks(app.lines);
      assert.deepEqual(more, []);
      assert.equal(line.event, 'update_check');
      assert.equal(line.available, null);
      assert.deepEqual(line.skipped.sort(), [
        'The release signature does not match the trusted update key',
        'The release signature does not match the trusted update key',
        'Version 0.9.0 is not newer than the installed 1.0.0',
        'Version 1.0.0 is not newer than the installed 1.0.0',
      ]);
      // A request for an unverified version is ignored, even one that sits in the folder.
      await request(root, '1.5.0');
      for (
        let i = 0;
        i < 100 && !app.lines.some((l) => l.event === 'update_request_ignored');
        i += 1
      )
        await sleep(10);
      assert.deepEqual(app.lines.at(-1), {
        event: 'update_request_ignored',
        version: '1.5.0',
        verified: null,
      });
      assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
      assert.equal((await app.about()).version, '1.0.0');
    } finally {
      await app.stop();
    }
  }));

test('rule 6: a missing source or a slow check leaves startup ready with one log line', () =>
  withTemp(async (dir) => {
    const { root } = await fixture(dir);
    for (const options of [
      { source: join(dir, 'no-such-releases') },
      { source: join(dir, 'slow'), find: () => new Promise(() => {}), checkTimeoutMs: 50 },
    ]) {
      const app = await started({ root, ...options });
      try {
        assert.equal((await app.about()).version, '1.0.0');
        await app.checked;
        const lines = checks(app.lines);
        assert.equal(lines.length, 1, JSON.stringify(lines));
        assert.equal(lines[0].event, 'update_check_failed');
        assert.match(lines[0].reason, options.find ? /no answer within 50 ms/ : /ENOENT/);
        assert.equal((await status(root)).available, null);
      } finally {
        await app.stop();
      }
    }
  }));

test('rule 2: without a click nothing is installed, and an earlier click never applies on start', () =>
  withTemp(async (dir) => {
    const { root, source, releaseOf } = await fixture(dir);
    await releaseOf('1.1.0');
    await mkdir(join(root, CHANNEL), { recursive: true });
    await request(root, '1.1.0');
    const app = await started({ root, source });
    try {
      await app.checked;
      await sleep(200);
      assert.equal((await status(root)).available.version, '1.1.0');
      assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
      assert.deepEqual(await readdir(join(root, CHANNEL)), ['status.json']);
      assert.equal((await app.about()).version, '1.0.0');
    } finally {
      await app.stop();
    }
  }));

test('the click updates through the verified release and restarts the new version', () =>
  withTemp(async (dir) => {
    const { root, state, source, pair, releaseOf } = await fixture(dir);
    const release = await releaseOf('1.1.0', { notes: 'Nueva versión.' });
    const calls = [];
    const record = (name) => async (args) => void calls.push([name, args.version]);
    const app = await started({ root, source, migrate: record('migrate'), ready: record('ready') });
    try {
      await app.about();
      await app.checked;
      // A request naming any other version than the verified one installs nothing.
      await request(root, '9.9.9');
      for (
        let i = 0;
        i < 100 && !app.lines.some((l) => l.event === 'update_request_ignored');
        i += 1
      )
        await sleep(10);
      assert.deepEqual(app.lines.at(-1), {
        event: 'update_request_ignored',
        version: '9.9.9',
        verified: '1.1.0',
      });
      assert.deepEqual(await readdir(join(root, 'versions')), ['1.0.0']);
      await request(root, '1.1.0');
      for (let i = 0; i < 400 && !app.lines.some((l) => l.event === 'updated'); i += 1)
        await sleep(10);
      assert.deepEqual(await app.about(), { version: '1.1.0', channel: join(root, CHANNEL) });
      assert.deepEqual(calls, [
        ['migrate', '1.1.0'],
        ['ready', '1.1.0'],
      ]);
      assert.equal((await readCurrent(root)).version, '1.1.0');
      assert.deepEqual(
        { ...(await status(root)), checkedAt: undefined },
        {
          format: 1,
          installed: '1.1.0',
          available: null,
          checkedAt: undefined,
        },
      );
      assert.deepEqual(
        app.lines.map((l) => l.event),
        [
          'started',
          'update_check',
          'update_request_ignored',
          'update_started',
          'updated',
          'started',
        ],
      );
      // The installed copy is the signed one, notes included.
      const installed = await readRelease(
        join(root, 'versions/1.1.0'),
        loadPublicKey(pair.publicKey.export({ type: 'spki', format: 'pem' })),
      );
      assert.equal(installed.manifest.notes, 'Nueva versión.');
      // The release source is only read; the state folder got its pre-update copy beside it.
      assert.deepEqual(await readdir(release), ['package', 'release.json', 'release.sig']);
      assert.equal(
        (await readdir(dirname(state))).filter((n) => n.startsWith('state.pre-update-')).length,
        1,
      );
    } finally {
      assert.equal(await app.stop(), 0);
    }
  }));

test('a failed update rolls back and starts the previous version again', () =>
  withTemp(async (dir) => {
    const { root, source, releaseOf } = await fixture(dir);
    await releaseOf('1.1.0');
    const app = await started({
      root,
      source,
      ready: async () => {
        throw new Error('synthetic readiness failure');
      },
    });
    try {
      await app.checked;
      await request(root, '1.1.0');
      for (let i = 0; i < 400 && app.lines.filter((l) => l.event === 'started').length < 2; i += 1)
        await sleep(10);
      const failed = app.lines.find((l) => l.event === 'update_failed');
      assert.equal(failed.code, 'ROLLED_BACK');
      assert.match(failed.reason, /synthetic readiness failure/);
      assert.equal((await app.about()).version, '1.0.0');
      assert.equal((await readCurrent(root)).version, '1.0.0');
      assert.deepEqual(
        { ...(await status(root)), checkedAt: undefined },
        {
          format: 1,
          installed: '1.0.0',
          available: null,
          checkedAt: undefined,
        },
      );
    } finally {
      await app.stop();
    }
  }));
