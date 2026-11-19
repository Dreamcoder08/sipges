// portable-go.mjs with a fake download (a synthetic zip handed to fetchImpl): the verified unzip
// and the bin path it prints, a mismatching download refused and deleted, an existing target
// refused before any download, a zip without go.exe refused, and the pin tied to go.mod's go line.
// Never downloads the real zip.
/* global Response */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { PIN_FILE, binPath, installPortableGo, parseArgs, readPin } from './portable-go.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

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

const GO_ZIP = zipOf({ 'go/VERSION': 'go1.27.0\n', 'go/bin/go.exe': 'go', 'go/bin/gofmt.exe': 'gofmt', 'go/src/go.mod': 'module std\n' });
const pinOf = (zip, extra = {}) => ({
  version: '1.27.0',
  file: 'go1.27.0.windows-amd64.zip',
  url: 'https://go.dev/dl/go1.27.0.windows-amd64.zip',
  sha256: createHash('sha256').update(zip).digest('hex'),
  size: zip.length,
  checked: '2026-11-18',
  ...extra,
});
/** A fetch that serves `zip` and counts its calls. */
function fakeFetch(zip) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(zip, { status: 200 });
  };
  return { fetchImpl, calls };
}

async function withTemp(run) {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-portable-go-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const hasUnzip = process.platform === 'win32' || spawnSync('unzip', ['-v']).status === 0;

test('the pinned Go is on go.mod\'s go line (same major.minor, not below it) and is the Go every other job sets up', async () => {
  const pin = await readPin();
  const goLine = (await readFile(join(repo, 'apps', 'api-go', 'go.mod'), 'utf8')).match(/^go (\S+)$/m)?.[1];
  const parts = (version) => version.split('.').map(Number);
  const [major, minor, patch] = parts(pin.version);
  const [goMajor, goMinor, goPatch = 0] = parts(goLine);
  assert.deepEqual([major, minor], [goMajor, goMinor], `portable-go.json pins ${pin.version}; go.mod says go ${goLine}: same major.minor`);
  assert.ok(patch >= goPatch, `portable-go.json pins ${pin.version}, below go.mod's go ${goLine}`);
  // The other windows-desktop.yml jobs set up Go with actions/setup-go: the same version, so the
  // kit's trusted binary gets the same security patches and the two cannot drift apart.
  const workflow = await readFile(join(repo, '.github', 'workflows', 'windows-desktop.yml'), 'utf8');
  const setUp = [...workflow.matchAll(/go-version: '([^']+)'/g)].map((match) => match[1]);
  assert.ok(setUp.length >= 2, 'the visit-kit and go-mode jobs set up Go');
  assert.deepEqual([...new Set(setUp)], [pin.version], `windows-desktop.yml sets up ${setUp.join(', ')}; the portable Go is ${pin.version}`);
  assert.equal(pin.file, `go${pin.version}.windows-amd64.zip`);
  assert.equal(pin.url, `https://go.dev/dl/${pin.file}`);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(pin.size) && pin.size > 50e6, 'the official zip is tens of megabytes');
  assert.equal(PIN_FILE, join(here, 'portable-go.json'));
});

test('a pin with a broken field is refused before any download', () =>
  withTemp(async (dir) => {
    const { fetchImpl, calls } = fakeFetch(GO_ZIP);
    for (const broken of [{ sha256: 'abc' }, { url: 'http://go.dev/dl/go1.27.0.windows-amd64.zip' }, { size: 0 }, { version: '1.27' }]) {
      await assert.rejects(installPortableGo({ out: join(dir, 'go'), pin: pinOf(GO_ZIP, broken), fetchImpl }), /^Error: portable-go\.json no es válido: /);
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(await readdir(dir), []);
  }));

test('the verified zip is unpacked into the new folder and the bin path is returned', { skip: !hasUnzip && 'needs unzip' }, () =>
  withTemp(async (dir) => {
    const out = join(dir, 'SIPGES-go');
    const { fetchImpl, calls } = fakeFetch(GO_ZIP);
    const said = [];
    const bin = await installPortableGo({ out, pin: pinOf(GO_ZIP), fetchImpl, say: (line) => said.push(line) });
    assert.deepEqual(calls, ['https://go.dev/dl/go1.27.0.windows-amd64.zip']);
    assert.equal(bin, join(out, 'go', 'bin'));
    assert.equal(bin, binPath(out));
    assert.equal(await readFile(join(bin, 'go.exe'), 'utf8'), 'go');
    assert.equal(await readFile(join(out, 'go', 'VERSION'), 'utf8'), 'go1.27.0\n');
    // Only the unpacked tree: the zip and the staging folder are gone.
    assert.deepEqual(await readdir(out), ['go']);
    assert.deepEqual(await readdir(dir), ['SIPGES-go']);
    assert.ok(said.some((line) => line.includes(pinOf(GO_ZIP).sha256)), said.join('\n'));
  }));

test('a download whose SHA-256 does not match the pin is refused and deleted, nothing unpacked', () =>
  withTemp(async (dir) => {
    const out = join(dir, 'SIPGES-go');
    const other = zipOf({ 'go/bin/go.exe': 'not the pinned go' });
    const { fetchImpl } = fakeFetch(other);
    await assert.rejects(
      installPortableGo({ out, pin: pinOf(GO_ZIP, { size: other.length }), fetchImpl }),
      (error) => {
        assert.match(error.message, /^La descarga de https:\/\/go\.dev\/dl\/go1\.27\.0\.windows-amd64\.zip no es el Go 1\.27\.0 fijado: /);
        assert.ok(error.message.includes('Se borró; no se descomprimió nada.'), error.message);
        return true;
      },
    );
    assert.deepEqual(await readdir(dir), [], 'neither the folder nor the download remain');
  }));

test('a download of the wrong size is refused and deleted too', () =>
  withTemp(async (dir) => {
    const { fetchImpl } = fakeFetch(GO_ZIP);
    await assert.rejects(installPortableGo({ out: join(dir, 'SIPGES-go'), pin: pinOf(GO_ZIP, { size: GO_ZIP.length + 1 }), fetchImpl }), /no es el Go 1\.27\.0 fijado/);
    assert.deepEqual(await readdir(dir), []);
  }));

test('an existing target folder is refused before any download, and left as it was', () =>
  withTemp(async (dir) => {
    const out = join(dir, 'SIPGES-go');
    await mkdir(out);
    const { fetchImpl, calls } = fakeFetch(GO_ZIP);
    await assert.rejects(installPortableGo({ out, pin: pinOf(GO_ZIP), fetchImpl }), (error) => {
      assert.ok(error.message.startsWith(`${out} ya existe`), error.message);
      return true;
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(await readdir(out), []);
  }));

test('a failed download says so and leaves nothing', () =>
  withTemp(async (dir) => {
    const fetchImpl = async () => new Response('gone', { status: 404 });
    await assert.rejects(installPortableGo({ out: join(dir, 'SIPGES-go'), pin: pinOf(GO_ZIP), fetchImpl }), /^Error: No se pudo descargar Go 1\.27\.0 de https:\/\/go\.dev\/dl\/go1\.27\.0\.windows-amd64\.zip \(HTTP 404\)/);
    assert.deepEqual(await readdir(dir), []);
  }));

test('a verified zip without go/bin/go.exe is refused and leaves nothing', { skip: !hasUnzip && 'needs unzip' }, () =>
  withTemp(async (dir) => {
    const zip = zipOf({ 'go/VERSION': 'go1.27.0\n' });
    const { fetchImpl } = fakeFetch(zip);
    await assert.rejects(installPortableGo({ out: join(dir, 'SIPGES-go'), pin: pinOf(zip), fetchImpl }), /no trae go\/bin\/go\.exe/);
    assert.deepEqual(await readdir(dir), []);
  }));

test('the command line takes exactly --out <new folder>', () => {
  assert.deepEqual(parseArgs(['--out', 'C:\\SIPGES-go']), { out: 'C:\\SIPGES-go', help: false });
  assert.deepEqual(parseArgs(['--help']), { out: undefined, help: true });
  for (const args of [[], ['--out'], ['--out', 'a', '--out', 'b'], ['--cache', 'x'], ['C:\\SIPGES-go']])
    assert.throws(() => parseArgs(args), /Uso: node deploy\\desktop\\windows\\portable-go\.mjs --out <carpeta nueva>/, JSON.stringify(args));
});

test('outside Windows x64 the command refuses: the pinned zip is the Windows amd64 Go', () =>
  withTemp(async (dir) => {
    const { fetchImpl, calls } = fakeFetch(GO_ZIP);
    await assert.rejects(
      installPortableGo({ out: join(dir, 'SIPGES-go'), pin: pinOf(GO_ZIP), fetchImpl, platform: 'linux', arch: 'x64', requireWindows: true }),
      /^Error: El Go fijado es para Windows x64; esta computadora es linux-x64/,
    );
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(dir, 'SIPGES-go')), false);
  }));

const signalsWork = process.platform !== 'win32';

test('Ctrl+C during the download removes the .partial folder and exits 130', { skip: !signalsWork && 'child.kill delivers no signal on Windows' }, () =>
  withTemp(async (dir) => {
    const out = join(dir, 'SIPGES-go');
    // A child that installs with a download that never ends, and says when it has started.
    const script = [
      `import { installPortableGo } from ${JSON.stringify(new URL('./portable-go.mjs', import.meta.url).href)};`,
      "const stalled = new ReadableStream({ start() {} });",
      "const fetchImpl = async () => { console.log('DOWNLOADING'); return new Response(stalled, { status: 200 }); };",
      `await installPortableGo({ out: ${JSON.stringify(out)}, pin: ${JSON.stringify(pinOf(GO_ZIP))}, fetchImpl, handleSignals: true });`,
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    await new Promise((resolveStarted, reject) => {
      child.stdout.on('data', (chunk) => chunk.toString().includes('DOWNLOADING') && resolveStarted());
      child.on('exit', (code) => reject(new Error(`exited ${code} before downloading: ${stderr}`)));
    });
    assert.equal((await readdir(dir)).filter((name) => name.endsWith('.partial')).length, 1, 'the staging folder exists while downloading');
    const exited = new Promise((resolveExit) => child.on('exit', (code, signal) => resolveExit({ code, signal })));
    child.kill('SIGINT');
    assert.deepEqual(await exited, { code: 130, signal: null }, stderr);
    assert.deepEqual(await readdir(dir), [], 'neither the .partial folder nor --out remain');
  }));
