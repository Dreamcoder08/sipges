// The pinned PostgreSQL 18 that the desktop's Go mode runs (docs/adr/0036 §1):
//
//   node deploy/desktop/postgresql/bundle.mjs --out <new folder> [--cache <folder>]
//
// pg18.json pins the EDB Windows x64 binaries zip by exact URL, size and SHA-256. The zip is
// downloaded once into the cache (`.data/postgresql` of this checkout by default) and used only
// when its SHA-256 matches; a download that does not match is deleted, never kept or unpacked.
// Without network and without a verified copy in the cache the bundle fails with a message that
// says so. The bundle keeps `bin`, `lib` and `share` and the two licence files of the command-line
// tools; pgAdmin 4, StackBuilder, `doc`, `include` and `symbols` are left out, and so are
// StackBuilder's own files inside `bin` (stackbuilder.exe, the wxWidgets DLLs) and the import
// libraries (*.lib). `postgresql.json` beside them records the pin it came from.
// deploy/desktop/package/builder.mjs --go calls this; the binaries are never committed.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
export const PIN_FILE = join(here, 'pg18.json');
export const DEFAULT_CACHE = join(repo, '.data', 'postgresql');

/** What the bundle keeps from the zip (paths inside it). */
export const KEEP = Object.freeze([
  'pgsql/bin',
  'pgsql/lib',
  'pgsql/share',
  'pgsql/server_license.txt',
  'pgsql/commandlinetools_3rd_party_licenses.txt',
]);
/** Files the Go mode needs, relative to the bundle: a zip without one of them is refused. */
export const REQUIRED = Object.freeze([
  'bin/initdb.exe',
  'bin/pg_ctl.exe',
  'bin/postgres.exe',
  'lib/plpgsql.dll',
  'lib/dict_snowball.dll',
  'share/postgres.bki',
  'share/tsearch_data/spanish.stop',
  'server_license.txt',
]);
/** Removed from `bin`: StackBuilder and its wxWidgets libraries, and import libraries. */
export const trimmed = (name) => /^stackbuilder\.exe$|^wx.*\.dll$|\.lib$/i.test(name);

const HEX64 = /^[0-9a-f]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** pnpm's minimumReleaseAge rule, kept for the binaries too: at least two weeks old when pinned. */
export const MINIMUM_AGE_DAYS = 14;

/** The pin, checked: a mistake here must stop the build, never download something else. */
export async function readPin(file = PIN_FILE) {
  const pin = JSON.parse(await readFile(file, 'utf8'));
  const problems = [];
  if (!/^18\.\d+-\d+$/.test(pin.version ?? '')) problems.push('version is not 18.<minor>-<build>');
  if (!HEX64.test(pin.sha256 ?? '')) problems.push('sha256 is not 64 lowercase hex digits');
  if (!Number.isInteger(pin.size) || pin.size <= 0) problems.push('size is not a byte count');
  if (typeof pin.url !== 'string' || !pin.url.startsWith('https://')) problems.push('url is not https');
  if (typeof pin.platform !== 'string' || typeof pin.arch !== 'string') problems.push('platform or arch missing');
  const published = Date.parse(pin.published ?? '');
  const checked = Date.parse(pin.checked ?? '');
  if (Number.isNaN(published) || Number.isNaN(checked)) problems.push('published or checked is not a date');
  else if (checked - published < MINIMUM_AGE_DAYS * DAY_MS)
    problems.push(`published less than ${MINIMUM_AGE_DAYS} days before it was pinned`);
  if (problems.length) throw new Error(`Invalid PostgreSQL pin ${file}: ${problems.join('; ')}`);
  return pin;
}

export const cachePath = (cache, pin) => join(cache, `postgresql-${pin.version}-${pin.sha256}.zip`);

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const offline = (pin, path, cause) =>
  new Error(
    `Cannot download PostgreSQL ${pin.version} from ${pin.url} (${cause}). The Go mode needs it: ` +
      `connect this computer to the network and build again, or put the zip with SHA-256 ${pin.sha256} at ${path}. ` +
      'Nothing unverified was used.',
  );

/**
 * The cached zip, downloaded first when missing. Returns its path only when its size and SHA-256
 * match the pin; a damaged cached copy is deleted and downloaded again.
 */
/**
 * GET through node:http(s), following up to `redirects` redirects (never from https to http), and
 * resolves with the 200 response stream. Not fetch: undici can abort the process with
 * `assert(!this.paused)` when the socket ends while a slow disk holds the body paused (Windows
 * runner, run 44262737447); a node:http stream piped to a file only applies backpressure.
 */
export function nodeGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const get = { 'https:': httpsGet, 'http:': httpGet }[target.protocol];
    if (!get) return reject(new Error(`unsupported protocol ${target.protocol}`));
    const request = get(target, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, target);
        if (redirects === 0) return reject(new Error('too many redirects'));
        if (target.protocol === 'https:' && next.protocol !== 'https:')
          return reject(new Error('redirect away from https refused'));
        return nodeGet(next.href, redirects - 1).then(resolve, reject);
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      resolve(response);
    });
    request.on('error', reject);
  });
}

export async function verifiedZip({ pin, cache = DEFAULT_CACHE, fetchImpl, say = () => {} }) {
  await mkdir(cache, { recursive: true });
  const path = cachePath(cache, pin);
  if (existsSync(path)) {
    if ((await sha256File(path)) === pin.sha256) return { path, downloaded: false };
    say(`The cached ${path} does not match the pinned SHA-256: deleted, downloading again.`);
    await rm(path, { force: true });
  }
  say(`Downloading PostgreSQL ${pin.version} (${Math.round(pin.size / 1e6)} MB) from ${pin.url}`);
  // `fetchImpl` is for tests that serve a web Response; the build itself uses node:http(s).
  let body;
  try {
    if (fetchImpl) {
      const response = await fetchImpl(pin.url, { redirect: 'follow' });
      if (!response.ok || !response.body) throw offline(pin, path, `HTTP ${response.status}`);
      body = Readable.fromWeb(response.body);
    } else {
      body = await nodeGet(pin.url);
    }
  } catch (error) {
    if (error.message.startsWith('Cannot download PostgreSQL')) throw error;
    throw offline(pin, path, error.cause?.code ?? error.code ?? error.message);
  }
  const partial = `${path}.${randomUUID()}.partial`;
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(body, tap, createWriteStream(partial, { flags: 'wx' }));
  } catch (error) {
    await rm(partial, { force: true });
    throw offline(pin, path, `interrupted: ${error.cause?.code ?? error.message}`);
  }
  const actual = hash.digest('hex');
  if (bytes !== pin.size || actual !== pin.sha256) {
    await rm(partial, { force: true });
    throw new Error(
      `The download from ${pin.url} is not the pinned PostgreSQL ${pin.version}: ${bytes} bytes with SHA-256 ${actual}, ` +
        `expected ${pin.size} bytes with SHA-256 ${pin.sha256}. It was deleted; nothing was unpacked.`,
    );
  }
  await rename(partial, path);
  return { path, downloaded: true };
}

/** The command that unpacks only KEEP: Windows' own tar (bsdtar reads zip), unzip elsewhere. */
export function extractCommand(zip, dir, platform = process.platform, env = process.env) {
  if (platform === 'win32')
    return { file: join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), args: ['-x', '-f', zip, '-C', dir, ...KEEP] };
  return { file: 'unzip', args: ['-q', zip, ...KEEP.map((entry) => (entry.endsWith('.txt') ? entry : `${entry}/*`)), '-d', dir] };
}

/**
 * Unpacks the verified zip into `out` (a new folder): bin, lib, share and the licences, trimmed,
 * with postgresql.json. A failure leaves no `out`.
 */
export async function bundlePostgres({
  out,
  cache = DEFAULT_CACHE,
  pin,
  fetchImpl,
  platform = process.platform,
  arch = process.arch,
  say = () => {},
}) {
  pin ??= await readPin();
  if (pin.platform !== platform || pin.arch !== arch)
    throw new Error(`The pinned PostgreSQL bundle is for ${pin.platform}-${pin.arch}; this build is ${platform}-${arch}`);
  if (existsSync(out)) throw new Error(`${out} already exists`);
  const { path } = await verifiedZip({ pin, cache, fetchImpl, say });
  const staging = `${out}.${randomUUID()}.partial`;
  await mkdir(staging, { recursive: true });
  try {
    const { file, args } = extractCommand(path, staging);
    const result = spawnSync(file, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0)
      throw new Error(`Cannot unpack ${path} with ${file}: ${result.error?.message ?? (result.stderr || `exit ${result.status}`).trim()}`);
    const root = join(staging, 'pgsql');
    for (const name of await readdir(join(root, 'bin'))) if (trimmed(name)) await rm(join(root, 'bin', name), { force: true });
    const missing = REQUIRED.filter((name) => !existsSync(join(root, ...name.split('/'))));
    if (missing.length) throw new Error(`The PostgreSQL zip lacks ${missing.join(', ')}`);
    await writeFile(join(root, 'postgresql.json'), `${JSON.stringify(pin, null, 2)}\n`, { flag: 'wx' });
    await rename(root, out);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  say(`PostgreSQL ${pin.version} bundled in ${out} (SHA-256 ${pin.sha256})`);
  return pin;
}

async function main(args) {
  const usage = 'Usage: node deploy/desktop/postgresql/bundle.mjs --out <new folder> [--cache <folder>]';
  if (args.length === 1 && args[0] === '--help') return console.log(usage);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--out', '--cache'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error(`Invalid options. ${usage}`);
    options[args[i]] = args[i + 1];
  }
  if (!options['--out']) throw new Error(`Missing --out. ${usage}`);
  await bundlePostgres({ out: resolve(options['--out']), cache: options['--cache'] ? resolve(options['--cache']) : DEFAULT_CACHE, say: console.log });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
