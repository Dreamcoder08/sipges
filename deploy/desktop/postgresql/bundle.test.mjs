// bundle.mjs with a synthetic zip served from 127.0.0.1: the verified download, the trim, a
// mismatching download deleted, the offline message, a verified cached copy used offline and a
// damaged one never used, and the real pin's own rules. Never downloads the real zip.
/* global fetch */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { crc32 } from 'node:zlib';
import { KEEP, MINIMUM_AGE_DAYS, PIN_FILE, bundlePostgres, cachePath, extractCommand, readPin, trimmed, verifiedZip } from './bundle.mjs';

/** A zip with stored (uncompressed) entries: enough for unzip and Windows' tar. */
function zipOf(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const FILES = {
  'pgsql/bin/initdb.exe': 'initdb',
  'pgsql/bin/pg_ctl.exe': 'pg_ctl',
  'pgsql/bin/postgres.exe': 'postgres',
  'pgsql/bin/stackbuilder.exe': 'gui',
  'pgsql/bin/wxbase3211u_vc_x64_custom.dll': 'gui',
  'pgsql/bin/libcurl.lib': 'import library',
  'pgsql/bin/libpq.dll': 'libpq',
  'pgsql/lib/plpgsql.dll': 'plpgsql',
  'pgsql/lib/dict_snowball.dll': 'snowball',
  'pgsql/share/postgres.bki': 'bki',
  'pgsql/share/tsearch_data/spanish.stop': 'de\nla\n',
  'pgsql/server_license.txt': 'licence',
  'pgsql/commandlinetools_3rd_party_licenses.txt': 'licences',
  'pgsql/pgAdmin 4/runtime/pgAdmin4.exe': 'pgadmin',
  'pgsql/doc/index.html': 'doc',
  'pgsql/include/libpq-fe.h': 'header',
  'pgsql/StackBuilder/bin/x.exe': 'gui',
  'pgsql/pgAdmin_license.txt': 'pgadmin licence',
};

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pinFor = (bytes, extra = {}) => ({
  version: '18.6-2',
  platform: process.platform,
  arch: process.arch,
  url: 'https://example.invalid/postgresql.zip',
  sha256: sha(bytes),
  size: bytes.length,
  published: '2026-10-05',
  checked: '2026-11-18',
  ...extra,
});

/** A fetch that serves `bytes` from a real local HTTP server and counts the requests. */
async function serving(bytes) {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.end(bytes);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return {
    fetchImpl: (_url, init) => fetch(url, init),
    requests: () => requests,
    close: () => new Promise((done) => server.close(done)),
  };
}
const unreachable = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
const scratch = () => mkdtemp(join(tmpdir(), 'sipges-pg-bundle-'));

async function listTree(dir, prefix = '') {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listTree(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

test('a verified download is cached and bundled: bin, lib, share and the licences, trimmed', async () => {
  const dir = await scratch();
  const zip = zipOf(FILES);
  const server = await serving(zip);
  try {
    const pin = pinFor(zip);
    const out = join(dir, 'postgresql');
    await bundlePostgres({ out, cache: join(dir, 'cache'), pin, fetchImpl: server.fetchImpl });
    assert.deepEqual(await listTree(out), [
      'bin/initdb.exe',
      'bin/libpq.dll',
      'bin/pg_ctl.exe',
      'bin/postgres.exe',
      'commandlinetools_3rd_party_licenses.txt',
      'lib/dict_snowball.dll',
      'lib/plpgsql.dll',
      'postgresql.json',
      'server_license.txt',
      'share/postgres.bki',
      'share/tsearch_data/spanish.stop',
    ]);
    assert.deepEqual(JSON.parse(await readFile(join(out, 'postgresql.json'), 'utf8')), pin);
    assert.equal(sha(await readFile(cachePath(join(dir, 'cache'), pin))), pin.sha256);
    assert.deepEqual(await readdir(dir), ['cache', 'postgresql'], 'no staging folder is left');
    // A second bundle from the verified cache needs no network.
    await bundlePostgres({ out: join(dir, 'again'), cache: join(dir, 'cache'), pin, fetchImpl: unreachable });
    assert.equal(server.requests(), 1);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a download that does not match the pinned SHA-256 is deleted and nothing is unpacked', async () => {
  const dir = await scratch();
  const zip = zipOf(FILES);
  const server = await serving(zip);
  try {
    const pin = pinFor(zip, { sha256: 'a'.repeat(64) });
    await assert.rejects(
      bundlePostgres({ out: join(dir, 'postgresql'), cache: join(dir, 'cache'), pin, fetchImpl: server.fetchImpl }),
      /is not the pinned PostgreSQL 18\.6-2: .* expected .* SHA-256 a{64}\. It was deleted; nothing was unpacked\./,
    );
    assert.deepEqual(await readdir(dir), ['cache']);
    assert.deepEqual(await readdir(join(dir, 'cache')), []);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('without network and without a verified copy the build stops with a clear message', async () => {
  const dir = await scratch();
  const zip = zipOf(FILES);
  try {
    const pin = pinFor(zip);
    const cache = join(dir, 'cache');
    await assert.rejects(bundlePostgres({ out: join(dir, 'postgresql'), cache, pin, fetchImpl: unreachable }), (error) => {
      assert.match(error.message, /^Cannot download PostgreSQL 18\.6-2 from https:\/\/example\.invalid\/postgresql\.zip \(ENOTFOUND\)\. The Go mode needs it: connect this computer to the network/);
      assert.ok(error.message.includes(cachePath(cache, pin)), 'names where a verified zip may be put');
      assert.ok(error.message.endsWith('Nothing unverified was used.'));
      return true;
    });
    assert.equal(existsSync(join(dir, 'postgresql')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a damaged cached copy is never used: offline it fails, online it is replaced', async () => {
  const dir = await scratch();
  const zip = zipOf(FILES);
  const server = await serving(zip);
  try {
    const pin = pinFor(zip);
    const cache = join(dir, 'cache');
    await verifiedZip({ pin, cache, fetchImpl: server.fetchImpl });
    const damaged = Buffer.from(zip);
    damaged[damaged.length - 30] ^= 0xff;
    await writeFile(cachePath(cache, pin), damaged);
    await assert.rejects(verifiedZip({ pin, cache, fetchImpl: unreachable }), /Cannot download PostgreSQL/);
    assert.equal(existsSync(cachePath(cache, pin)), false, 'the damaged copy was deleted');
    const again = await verifiedZip({ pin, cache, fetchImpl: server.fetchImpl });
    assert.equal(again.downloaded, true);
    assert.equal(sha(await readFile(again.path)), pin.sha256);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a zip without a file the Go mode needs is refused and leaves nothing', async () => {
  const dir = await scratch();
  const zip = zipOf(Object.fromEntries(Object.entries(FILES).filter(([name]) => name !== 'pgsql/lib/dict_snowball.dll')));
  const server = await serving(zip);
  try {
    await assert.rejects(
      bundlePostgres({ out: join(dir, 'postgresql'), cache: join(dir, 'cache'), pin: pinFor(zip), fetchImpl: server.fetchImpl }),
      /The PostgreSQL zip lacks lib\/dict_snowball\.dll/,
    );
    assert.deepEqual(await readdir(dir), ['cache']);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the bundle is refused on another platform than the pin', async () => {
  const zip = zipOf(FILES);
  await assert.rejects(
    bundlePostgres({ out: join(tmpdir(), 'never'), pin: pinFor(zip, { platform: 'win32', arch: 'x64' }), platform: 'linux', arch: 'x64', fetchImpl: unreachable }),
    /The pinned PostgreSQL bundle is for win32-x64; this build is linux-x64/,
  );
});

test('the repository pin: exact EDB zip, SHA-256 and size, at least two weeks old when pinned', async () => {
  const pin = await readPin(PIN_FILE);
  assert.equal(pin.url, `https://get.enterprisedb.com/postgresql/postgresql-${pin.version}-windows-x64-binaries.zip`);
  assert.equal(pin.platform, 'win32');
  assert.equal(pin.arch, 'x64');
  assert.ok(Date.parse(pin.checked) - Date.parse(pin.published) >= MINIMUM_AGE_DAYS * 86_400_000);
  const young = join(await scratch(), 'pin.json');
  await writeFile(young, JSON.stringify({ ...pin, published: '2026-11-12' }));
  await assert.rejects(readPin(young), /published less than 14 days before it was pinned/);
});

test('the unpack command takes only what the bundle keeps', () => {
  const win = extractCommand('C:\\c\\pg.zip', 'C:\\s', 'win32', { SystemRoot: 'C:\\Windows' });
  assert.equal(win.file, join('C:\\Windows', 'System32', 'tar.exe'));
  assert.deepEqual(win.args, ['-x', '-f', 'C:\\c\\pg.zip', '-C', 'C:\\s', ...KEEP]);
  const other = extractCommand('/c/pg.zip', '/s', 'linux');
  assert.deepEqual(other.args, ['-q', '/c/pg.zip', 'pgsql/bin/*', 'pgsql/lib/*', 'pgsql/share/*', 'pgsql/server_license.txt', 'pgsql/commandlinetools_3rd_party_licenses.txt', '-d', '/s']);
  assert.deepEqual(['stackbuilder.exe', 'wxmsw3211u_core_vc_x64_custom.dll', 'libcurl.lib', 'pg_ctl.exe', 'libpq.dll'].filter(trimmed), [
    'stackbuilder.exe',
    'wxmsw3211u_core_vc_x64_custom.dll',
    'libcurl.lib',
  ]);
});

// The default download goes through node:http(s), not fetch: undici's fetch can abort the process
// with `assert(!this.paused)` when the socket ends while a slow disk holds the body paused
// (seen on the Windows runner, run 44262737447). Redirects are followed, a loop is refused.
test('the default download uses node:http, follows a redirect and refuses a redirect loop', async () => {
  const dir = await scratch();
  const zip = zipOf(FILES);
  const server = createServer((req, res) => {
    if (req.url === '/moved') return res.writeHead(302, { Location: '/zip' }).end();
    if (req.url === '/loop') return res.writeHead(302, { Location: '/loop' }).end();
    res.writeHead(200, { 'Content-Length': zip.length });
    res.end(zip);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const pin = pinFor(zip, { url: `${base}/moved` });
    const got = await verifiedZip({ pin, cache: join(dir, 'cache') });
    assert.equal(got.downloaded, true);
    assert.equal(sha(await readFile(got.path)), pin.sha256);
    await assert.rejects(
      verifiedZip({ pin: pinFor(zip, { url: `${base}/loop` }), cache: join(dir, 'loop') }),
      /Cannot download PostgreSQL.*too many redirects/s,
    );
  } finally {
    await new Promise((done) => server.close(done));
    await rm(dir, { recursive: true, force: true });
  }
});
