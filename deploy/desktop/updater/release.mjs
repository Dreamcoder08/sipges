// Signed desktop releases: a local directory with `package/` (the builder output), `release.json`
// (version, minimum previous version, platform, SHA-256 of every file, internal directory links)
// and `release.sig` (base64 Ed25519 signature of the exact `release.json` bytes).
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

export const MANIFEST = 'release.json';
export const SIGNATURE = 'release.sig';
export const PUBLIC_KEY = 'update-public-key.pem';
const REQUIRED = ['metadata.json', 'start.mjs', PUBLIC_KEY];
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
/** Release notes shown in the update notice: plain text, optional. */
export const MAX_NOTES_LENGTH = 4000;
const validNotes = (notes) =>
  notes === undefined ||
  notes === null ||
  (typeof notes === 'string' && notes.trim() !== '' && notes.length <= MAX_NOTES_LENGTH);
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export const refuse = (message) => new UpdateError('REFUSED', message);

export const isVersion = (value) => typeof value === 'string' && SEMVER.test(value);

/** Semantic Versioning 2.0 precedence; build metadata is ignored. */
export function compareVersions(a, b) {
  const [ma, mb] = [SEMVER.exec(a), SEMVER.exec(b)];
  if (!ma || !mb) throw new Error(`Invalid version: ${ma ? b : a}`);
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  if (!ma[4] || !mb[4]) return ma[4] ? -1 : mb[4] ? 1 : 0;
  const [pa, pb] = [ma[4].split('.'), mb[4].split('.')];
  for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
    const [na, nb] = [/^\d+$/.test(pa[i]), /^\d+$/.test(pb[i])];
    if (na && nb && Number(pa[i]) !== Number(pb[i]))
      return Math.sign(Number(pa[i]) - Number(pb[i]));
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return Math.sign(pa.length - pb.length);
}

/** A package path: POSIX separators, no traversal, nothing Windows would alias or reject. */
export function isSafeRelative(path) {
  if (typeof path !== 'string' || path === '' || path.length > 1024) return false;
  for (const char of path) if (char.charCodeAt(0) < 32 || '\\:*?"<>|'.includes(char)) return false;
  return path
    .split('/')
    .every((s) => s !== '' && s !== '.' && s !== '..' && !s.endsWith('.') && !s.endsWith(' '));
}

export const inside = (parent, child) => {
  const r = relative(parent, child);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Lists a tree without following links: files, directory links and directories by POSIX path. */
export async function scanTree(root) {
  const files = new Map();
  const links = new Map();
  const directories = [];
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) links.set(rel, path);
      else if (entry.isDirectory()) {
        directories.push(rel);
        await walk(path, rel);
      } else if (entry.isFile()) files.set(rel, path);
      else throw refuse(`Unsupported file type in package: ${rel}`);
    }
  };
  await walk(root, '');
  return { files, links, directories };
}

const linkTarget = (rel, target) => posix.normalize(posix.join(posix.dirname(rel), target));

function validateManifest(manifest) {
  const fail = (why) => refuse(`The release manifest is invalid: ${why}`);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw fail('not an object');
  if (manifest.format !== 1) throw fail('unknown format');
  if (!isVersion(manifest.version)) throw fail('version');
  if (manifest.minimumPrevious !== null && !isVersion(manifest.minimumPrevious))
    throw fail('minimum previous version');
  if (typeof manifest.platform !== 'string' || typeof manifest.arch !== 'string')
    throw fail('platform');
  if (!validNotes(manifest.notes)) throw fail('notes');
  const { files, links, directories } = manifest;
  if (!files || typeof files !== 'object' || !links || typeof links !== 'object')
    throw fail('lists');
  if (!Array.isArray(directories)) throw fail('directories');
  const seen = new Set();
  const all = [...Object.keys(files), ...Object.keys(links), ...directories];
  for (const path of all) {
    if (!isSafeRelative(path)) throw fail(`unsafe path ${JSON.stringify(path)}`);
    if (seen.has(path.toLowerCase())) throw fail(`duplicate path ${path}`);
    seen.add(path.toLowerCase());
  }
  for (const reserved of [MANIFEST, SIGNATURE])
    if (seen.has(reserved)) throw fail(`reserved name ${reserved}`);
  for (const required of REQUIRED) if (!(required in files)) throw fail(`missing ${required}`);
  for (const hash of Object.values(files))
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw fail('hash');
  for (const [path, target] of Object.entries(links)) {
    if (
      typeof target !== 'string' ||
      target === '' ||
      posix.isAbsolute(target) ||
      target.includes('\\')
    )
      throw fail(`link ${path}`);
    const resolved = linkTarget(path, target);
    if (resolved === '..' || resolved.startsWith('../') || !directories.includes(resolved))
      throw fail(`link ${path} leaves the package`);
  }
  for (const path of all)
    for (const link of Object.keys(links))
      if (path.startsWith(`${link}/`)) throw fail(`path ${path} under link ${link}`);
}

/**
 * The SHA-256 of a key's public part (SPKI DER), in hex: what `update.mjs --trust-release-key`
 * prints at install and what the visit kit writes to fingerprint.txt. Takes a public or private
 * KeyObject or PEM.
 */
export function keyFingerprint(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

export function loadPublicKey(pem) {
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw refuse('The update key is not a valid public key');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw refuse('The update key is not an Ed25519 key');
  return key;
}

/** Verifies the signature first, then the manifest shape. Returns the exact verified bytes. */
export async function readRelease(releaseDir, publicKey) {
  const path = join(releaseDir, MANIFEST);
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw refuse(`No ${MANIFEST} in the release directory`);
  }
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES)
    throw refuse(`${MANIFEST} is not a file or is too large`);
  const bytes = await readFile(path);
  let text;
  try {
    text = (await readFile(join(releaseDir, SIGNATURE), 'utf8')).trim();
  } catch {
    throw refuse(`No ${SIGNATURE} in the release directory`);
  }
  const signature = Buffer.from(text, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== text)
    throw refuse('The release signature is malformed');
  if (!verify(null, bytes, publicKey, signature))
    throw refuse('The release signature does not match the trusted update key');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw refuse('The release manifest is invalid: not JSON');
  }
  validateManifest(manifest);
  return { manifest, bytes, signature: `${text}\n` };
}

/** Copies a built package into a new release directory, embeds the public key and signs it. */
export async function createRelease({
  packageDir,
  releaseDir,
  privateKey,
  minimumPrevious = null,
  notes = null,
}) {
  const key =
    typeof privateKey === 'object' && privateKey.type ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key must be Ed25519');
  const metadata = JSON.parse(await readFile(join(packageDir, 'metadata.json'), 'utf8'));
  if (!isVersion(metadata.version)) throw new Error('metadata.json has no valid version');
  if (!validNotes(notes))
    throw new Error(
      `Release notes must be non-empty text of at most ${MAX_NOTES_LENGTH} characters`,
    );
  if (minimumPrevious !== null) {
    if (!isVersion(minimumPrevious)) throw new Error('Invalid minimum previous version');
    if (compareVersions(minimumPrevious, metadata.version) >= 0)
      throw new Error('The minimum previous version must be older than the release');
  }
  await mkdir(releaseDir, { mode: 0o700 });
  const target = join(releaseDir, 'package');
  await cp(packageDir, target, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  });
  await writeFile(
    join(target, PUBLIC_KEY),
    createPublicKey(key).export({ type: 'spki', format: 'pem' }),
  );
  const scan = await scanTree(target);
  const root = await realpath(target);
  const links = {};
  for (const [rel, path] of [...scan.links].sort()) {
    const real = await realpath(path);
    if (!inside(root, real) || !(await stat(real)).isDirectory())
      throw new Error(`Link must point to a directory inside the package: ${rel}`);
    links[rel] = relative(await realpath(dirname(path)), real)
      .split(sep)
      .join('/');
  }
  const files = {};
  for (const [rel, path] of [...scan.files].sort()) files[rel] = await hashFile(path);
  const manifest = {
    format: 1,
    version: metadata.version,
    minimumPrevious,
    platform: metadata.platform,
    arch: metadata.arch,
    ...(notes === null ? {} : { notes }),
    files,
    links,
    directories: scan.directories.sort(),
  };
  validateManifest(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(releaseDir, MANIFEST), bytes, { flag: 'wx' });
  await writeFile(join(releaseDir, SIGNATURE), `${sign(null, bytes, key).toString('base64')}\n`, {
    flag: 'wx',
  });
  return manifest;
}

const USAGE =
  'Usage: node deploy/desktop/updater/release.mjs --package <dir> --out <new dir> --key <private.pem> [--minimum-previous <version>] [--notes <text>]';

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(USAGE);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const [key, value] = [args[i], args[i + 1]];
    if (
      !['--package', '--out', '--key', '--minimum-previous', '--notes'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      options[key]
    )
      throw new Error('Invalid options; use --help');
    options[key] = value;
  }
  for (const key of ['--package', '--out', '--key'])
    if (!options[key]) throw new Error(`Missing ${key}`);
  const manifest = await createRelease({
    packageDir: resolve(options['--package']),
    releaseDir: resolve(options['--out']),
    privateKey: await readFile(resolve(options['--key'])),
    minimumPrevious: options['--minimum-previous'] ?? null,
    notes: options['--notes'] ?? null,
  });
  console.log(`Release ${manifest.version} signed: ${resolve(options['--out'])}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
