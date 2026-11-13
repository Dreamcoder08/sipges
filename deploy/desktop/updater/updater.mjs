// Atomic, recoverable update of a managed desktop install. Layout of an install root:
//   versions/<version>/   complete verified copies (files copied, never hardlinked)
//   current.json          the pointer, replaced only by one rename of a fully written temp file
//   install.json          absolute state folder, written once
//   update.lock, update-journal.json, update.log (JSON lines)
// The state folder lives outside versions/. The updater only copies it; the injected migration
// is the only writer, and every failure after it restores the folder from the pre-update copy.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  appendFile,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  statfs as fsStatfs,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import {
  MANIFEST,
  PUBLIC_KEY,
  SIGNATURE,
  UpdateError,
  compareVersions,
  hashFile,
  inside,
  isVersion,
  loadPublicKey,
  readRelease,
  refuse,
  scanTree,
} from './release.mjs';

export { UpdateError };
export const STEPS = [
  'locked',
  'verified',
  'staged',
  'installed',
  'state-copied',
  'rehearsed',
  'migrated',
  'switched',
  'ready',
  'committed',
];
const POINTER = 'current.json';
const INSTALL = 'install.json';
const LOCK = 'update.lock';
const JOURNAL = 'update-journal.json';
const LOG = 'update.log';
const VERSIONS = 'versions';
// The state may already have been changed by the migration in these journal phases.
const STATE_AT_RISK = new Set(['migrating', 'switched', 'restoring']);
// A running update rewrites its lock this often; a lock not rewritten for LOCK_STALE_MS is
// left by a process that is gone, even when its pid now belongs to another program.
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 120_000;
// Files hashed at once when a release is checked before it is offered.
const HASH_CONCURRENCY = 16;
// Room counted per file or folder of the state on top of its bytes (file system blocks).
const ENTRY_OVERHEAD_BYTES = 4096;

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Windows refuses a rename while another process holds the file or folder (an antivirus scan,
// the search indexer, an open Explorer window), sometimes for many seconds. Such a refusal is
// retried with pauses growing from RENAME_FIRST_WAIT_MS to RENAME_MAX_WAIT_MS until
// RENAME_RETRY_MS have passed since the first attempt; then the last error is thrown unchanged.
const RENAME_RETRY_MS = 45_000;
const RENAME_FIRST_WAIT_MS = 100;
const RENAME_MAX_WAIT_MS = 2_000;

/** `move`, `wait`, `now` and `platform` are for tests. */
export async function renameRetry(
  from,
  to,
  { move = rename, wait = sleep, now = Date.now, platform = process.platform } = {},
) {
  const deadline = now() + RENAME_RETRY_MS;
  for (let pause = RENAME_FIRST_WAIT_MS; ; pause = Math.min(pause * 2, RENAME_MAX_WAIT_MS)) {
    try {
      return await move(from, to);
    } catch (error) {
      const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      const left = deadline - now();
      if (platform !== 'win32' || !transient || left <= 0) throw error;
      await wait(Math.min(pause, left));
    }
  }
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Writes and flushes a temp file beside the target, then replaces the target with one rename. */
async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameRetry(temporary, path);
  await syncDirectory(dirname(path));
}

const stamp = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

async function freeName(base) {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await exists(candidate)) && !(await exists(`${candidate}.partial`))) return candidate;
  }
}

/** A complete copy or nothing at the target name: copy under `.partial`, then rename. */
async function copyTree(source, target) {
  // Copying a link would copy the link, not the data: the "copy" would follow the live folder.
  if (!(await lstat(source)).isDirectory())
    throw refuse(`The state folder ${source} is a link; record the real folder instead`);
  const partial = `${target}.partial`;
  await rm(partial, { recursive: true, force: true });
  try {
    await cp(source, partial, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  } catch (error) {
    // A partial copy (a full disk) is the updater's own; the source was only read.
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await renameRetry(partial, target);
}

async function log(root, entry) {
  await appendFile(
    join(root, LOG),
    `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`,
  );
}

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

async function readLock(path) {
  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), lstat(path)]);
    let held = null;
    try {
      held = JSON.parse(text);
    } catch {
      held = null;
    }
    return { text, held, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * A lock is stale when its heartbeat (or, for an unreadable one, its file time) is older than
 * LOCK_STALE_MS, whatever its pid, or when its process is gone.
 */
function lockIsStale({ held, mtimeMs }) {
  const beat = Date.parse(held?.heartbeat ?? held?.time ?? '');
  const last = Number.isFinite(beat) ? beat : mtimeMs;
  if (Date.now() - last > LOCK_STALE_MS) return true;
  return Boolean(held) && Number.isInteger(held.pid) && !alive(held.pid);
}

/**
 * Removes a stale lock. Only one process at a time may do it: the takeover is guarded by an
 * exclusively created directory, so two racers can never move each other's fresh lock aside.
 * Inside the guard the lock is read again and removed only if it is still the stale one found.
 * A guard left by a crash is cleared once it is older than LOCK_STALE_MS.
 */
async function takeOver(path, found) {
  const guard = `${path}.takeover`;
  try {
    await mkdir(guard);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await lstat(guard).catch(() => null);
    if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS)
      await rm(guard, { recursive: true, force: true });
    throw new UpdateError('BUSY', 'Another update is taking over the lock');
  }
  try {
    const current = await readLock(path);
    if (!current || current.text !== found.text) return;
    const aside = `${path}.stale-${randomUUID()}`;
    try {
      await renameRetry(path, aside);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    await rm(aside, { force: true });
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

/**
 * The lock is created complete or not at all: the full content is written to a temp file and
 * hard-linked to the lock name, which fails when the name exists. While held, a heartbeat
 * rewrites it; release removes it only while it still carries this run's token.
 */
async function lock(root) {
  const path = join(root, LOCK);
  const token = randomUUID();
  const body = () =>
    JSON.stringify({ format: 2, pid: process.pid, token, heartbeat: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temporary = `${path}.${token}.tmp`;
    await writeFile(temporary, body(), { flag: 'wx', mode: 0o600 });
    let created = false;
    try {
      await link(temporary, path);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    } finally {
      await rm(temporary, { force: true });
    }
    if (created) return holdLock(path, token, body);
    const found = await readLock(path);
    if (!found) continue;
    if (!lockIsStale(found))
      throw new UpdateError(
        'BUSY',
        Number.isInteger(found.held?.pid)
          ? `Another update is running (process ${found.held.pid})`
          : 'Another update is starting',
      );
    // A crashed update: the journal decides what to undo.
    await takeOver(path, found);
  }
  throw new UpdateError('BUSY', 'Could not take the update lock');
}

function holdLock(path, token, body) {
  let beating = Promise.resolve();
  const timer = setInterval(() => {
    beating = (async () => {
      const current = await readLock(path);
      if (current?.held?.token !== token) return clearInterval(timer);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, body(), { flag: 'wx', mode: 0o600 });
      await renameRetry(temporary, path);
    })().catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await beating;
    const current = await readLock(path).catch(() => null);
    if (current?.held?.token === token) await rm(path, { force: true });
  };
}

function pointerDir(root, pointer) {
  return isAbsolute(pointer.path) ? pointer.path : join(root, ...pointer.path.split('/'));
}

/** The current version: `{ version, dir, adopted }`, or null when nothing is installed. */
export async function readCurrent(root) {
  const pointer = await readJson(join(resolve(root), POINTER));
  if (!pointer) return null;
  if (!isVersion(pointer.version) || typeof pointer.path !== 'string')
    throw new UpdateError('CORRUPT', `${POINTER} is invalid`);
  return {
    version: pointer.version,
    dir: pointerDir(resolve(root), pointer),
    adopted: pointer.adopted === true,
  };
}

const writePointer = (root, version, path, adopted) =>
  writeJsonAtomic(join(root, POINTER), { format: 1, version, path, adopted });

/** Re-checks the current version: metadata, entry and, for managed copies, every signed hash. */
export async function inspectInstall(root) {
  const current = await readCurrent(root);
  if (!current) return { complete: false, reason: 'nothing installed' };
  const result = (reason) => ({ ...current, complete: reason === null, reason });
  const metadata = await readJson(join(current.dir, 'metadata.json')).catch(() => null);
  if (metadata?.version !== current.version) return result('metadata.json does not match');
  if (!(await exists(join(current.dir, 'start.mjs')))) return result('start.mjs is missing');
  if (current.adopted) return result(null);
  const manifest = await readJson(join(current.dir, MANIFEST)).catch(() => null);
  if (!manifest || manifest.version !== current.version) return result(`${MANIFEST} is missing`);
  const scan = await scanTree(current.dir);
  const expected = [...Object.keys(manifest.files), MANIFEST, SIGNATURE].sort();
  if (JSON.stringify([...scan.files.keys()].sort()) !== JSON.stringify(expected))
    return result('the file list differs from the release');
  for (const [rel, hash] of Object.entries(manifest.files))
    if ((await hashFile(scan.files.get(rel))) !== hash) return result(`${rel} differs`);
  if (
    JSON.stringify([...scan.links.keys()].sort()) !==
    JSON.stringify(Object.keys(manifest.links).sort())
  )
    return result('the links differ from the release');
  if (process.platform !== 'win32')
    for (const [rel, target] of Object.entries(manifest.links))
      if ((await readlink(scan.links.get(rel))) !== target) return result(`link ${rel} differs`);
  for (const directory of manifest.directories)
    if (!(await exists(join(current.dir, ...directory.split('/')))))
      return result(`${directory} is missing`);
  return result(null);
}

/** The absolute state folder recorded at install or adoption. */
export const readStateDir = (root) => stateDirOf(resolve(root));

async function stateDirOf(root) {
  const config = await readJson(join(root, INSTALL));
  if (!config || typeof config.stateDir !== 'string' || !isAbsolute(config.stateDir))
    throw new UpdateError('CORRUPT', `${INSTALL} is missing or invalid`);
  return config.stateDir;
}

/**
 * The real path of a state folder: a link (or Windows junction) is resolved, so the pre-update
 * copy holds the data and not a second way into the live folder. A folder not created yet (the
 * launcher prepares it) is resolved through its parent.
 */
async function canonicalState(stateDir) {
  try {
    return await realpath(stateDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    return join(await realpath(dirname(stateDir)), basename(stateDir));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return stateDir;
  }
}

/**
 * Refuses a state folder that cannot be copied faithfully (a link, or a link or special file
 * inside) and an update without room beside it for the copies it takes: the pre-update copy,
 * one restore and, for an adopted install, the rehearsal copy. Nothing is written.
 */
async function checkStateRoom(stateDir, copies, statfs) {
  let info;
  try {
    info = await lstat(stateDir);
  } catch (error) {
    if (error.code === 'ENOENT') throw refuse(`The state folder does not exist: ${stateDir}`);
    throw error;
  }
  if (info.isSymbolicLink())
    throw refuse(`The state folder ${stateDir} is a link; record the real folder instead`);
  if (!info.isDirectory()) throw refuse(`The state folder is not a folder: ${stateDir}`);
  let bytes = 0;
  let entries = 1;
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      entries += 1;
      if (entry.isDirectory()) await walk(path, rel);
      else if (entry.isFile()) bytes += (await lstat(path)).size;
      else
        throw refuse(
          `The state folder holds a link or special file (${rel}); it cannot be copied safely`,
        );
    }
  };
  await walk(stateDir, '');
  const needed = copies * (bytes + entries * ENTRY_OVERHEAD_BYTES);
  const disk = await statfs(dirname(stateDir));
  const free = Number(disk.bavail) * Number(disk.bsize);
  if (free < needed)
    throw refuse(
      `Not enough free disk beside the state folder for the pre-update copy and one restore: ${needed} bytes needed, ${free} free`,
    );
}

function checkStateDir(root, stateDir) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir))
    throw refuse('The state folder must be an absolute path');
  if (inside(join(root, VERSIONS), stateDir) || inside(stateDir, root))
    throw refuse(
      'The state folder must be outside the install root versions and must not contain it',
    );
}

async function recordStateDir(root, stateDir) {
  checkStateDir(root, stateDir);
  const existing = await readJson(join(root, INSTALL));
  if (existing && existing.stateDir !== stateDir)
    throw refuse(`This install already uses the state folder ${existing.stateDir}`);
  if (!existing) await writeJsonAtomic(join(root, INSTALL), { format: 1, stateDir });
}

async function trustedKey(versionDir, trustKey) {
  const path = join(versionDir, PUBLIC_KEY);
  if (await exists(path)) {
    const installed = await readFile(path, 'utf8');
    if (trustKey !== undefined && trustKey.trim() !== installed.trim())
      throw refuse(
        'The installed version already defines the update key; --trust-key is only for an install without one',
      );
    return loadPublicKey(installed);
  }
  if (trustKey === undefined)
    throw refuse('Updates are disabled: the installed version has no update key');
  return loadPublicKey(trustKey);
}

function checkTarget(current, manifest) {
  if (current && compareVersions(manifest.version, current.version) <= 0)
    throw refuse(`Version ${manifest.version} is not newer than the installed ${current.version}`);
  if (
    current &&
    manifest.minimumPrevious &&
    compareVersions(current.version, manifest.minimumPrevious) < 0
  )
    throw refuse(
      `Version ${manifest.version} requires at least ${manifest.minimumPrevious} installed; found ${current.version}`,
    );
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw refuse(
      `Release is for ${manifest.platform}/${manifest.arch}; this computer is ${process.platform}/${process.arch}`,
    );
}

function compareLists(found, expected) {
  const actual = [...found];
  const wanted = new Set(expected);
  for (const path of [...actual].sort())
    if (!wanted.has(path))
      throw refuse(`The release package does not match its manifest: unlisted ${path}`);
  const present = new Set(actual);
  for (const path of [...expected].sort())
    if (!present.has(path))
      throw refuse(`The release package does not match its manifest: missing ${path}`);
}

/** The package's file, link and folder lists equal the signed ones. Returns the scan. */
async function checkPackageLists(source, manifest) {
  try {
    if (!(await lstat(source)).isDirectory()) throw refuse('The release package is not a folder');
  } catch (error) {
    if (error.code === 'ENOENT') throw refuse('The release has no package folder');
    throw error;
  }
  const scan = await scanTree(source);
  compareLists(scan.files.keys(), Object.keys(manifest.files));
  compareLists(scan.links.keys(), Object.keys(manifest.links));
  compareLists(scan.directories, manifest.directories);
  return scan;
}

/** The version a package says it is must be the version that was signed. */
async function checkMetadata(dir, manifest) {
  const metadata = await readJson(join(dir, 'metadata.json')).catch(() => null);
  if (metadata?.version !== manifest.version)
    throw refuse(
      `metadata.json says ${metadata?.version ?? 'nothing'} but the signed release is ${manifest.version}`,
    );
}

/** Every file of the package hashed in place against the signed list, nothing copied. */
async function checkPackage(releaseDir, manifest) {
  const source = join(releaseDir, 'package');
  const scan = await checkPackageLists(source, manifest);
  const entries = Object.entries(manifest.files);
  for (let i = 0; i < entries.length; i += HASH_CONCURRENCY)
    await Promise.all(
      entries.slice(i, i + HASH_CONCURRENCY).map(async ([rel, hash]) => {
        if ((await hashFile(scan.files.get(rel))) !== hash)
          throw refuse(`File does not match the signed release: ${rel}`);
      }),
    );
  await checkMetadata(source, manifest);
}

/**
 * The newest release in `source` that `update` would accept, verified the same way (signature
 * with the installed key, newer version, minimum previous, platform, every file hash and the
 * package version) but without copying anything. `source` is one release directory or a
 * directory of them. Signed manifests are checked first; packages are then hashed newest first
 * and the search stops at the first that verifies, so keeping old releases costs no time.
 * Refused candidates that were examined are listed in `skipped`; an install without an update
 * key is refused as a whole (updates disabled).
 */
export async function findUpdate({ root, source }) {
  root = resolve(root);
  source = resolve(source);
  const current = await readCurrent(root);
  if (!current) throw new UpdateError('CORRUPT', 'No installed version here');
  const key = await trustedKey(current.dir, undefined);
  const candidates = (await exists(join(source, MANIFEST)))
    ? [source]
    : (await readdir(source, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(source, entry.name))
        .sort();
  const skipped = [];
  const signed = [];
  for (const release of candidates) {
    try {
      const { manifest } = await readRelease(release, key);
      checkTarget(current, manifest);
      signed.push({ release, manifest });
    } catch (error) {
      if (error.code !== 'REFUSED') throw error;
      skipped.push({ release, reason: error.message });
    }
  }
  // Newest first; the same version in two folders is tried in name order.
  signed.sort(
    (a, b) =>
      compareVersions(b.manifest.version, a.manifest.version) || (a.release < b.release ? -1 : 1),
  );
  for (const { release, manifest } of signed) {
    try {
      await checkPackage(release, manifest);
      const available = { version: manifest.version, notes: manifest.notes ?? null, release };
      return { installed: current.version, available, skipped };
    } catch (error) {
      if (error.code !== 'REFUSED') throw error;
      skipped.push({ release, reason: error.message });
    }
  }
  return { installed: current.version, available: null, skipped };
}

/** Copies exactly the signed files into a staging folder, hashing the copy, not the source. */
async function stage(root, releaseDir, verified) {
  const { manifest } = verified;
  const versions = join(root, VERSIONS);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const staging = join(versions, `.staging-${randomUUID()}`);
  const final = join(versions, manifest.version);
  const source = join(releaseDir, 'package');
  try {
    const scan = await checkPackageLists(source, manifest);
    await mkdir(staging, { mode: 0o700 });
    for (const directory of manifest.directories)
      await mkdir(join(staging, ...directory.split('/')), { recursive: true });
    for (const [rel, hash] of Object.entries(manifest.files)) {
      const target = join(staging, ...rel.split('/'));
      await copyFile(scan.files.get(rel), target, constants.COPYFILE_EXCL);
      if ((await hashFile(target)) !== hash)
        throw refuse(`File does not match the signed release: ${rel}`);
    }
    for (const [rel, target] of Object.entries(manifest.links)) {
      const path = join(staging, ...rel.split('/'));
      // Junctions need no privilege on Windows but take an absolute target: the final location.
      if (process.platform === 'win32') {
        const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
        await symlink(join(final, ...resolved.split('/')), path, 'junction');
      } else {
        await symlink(target, path, 'dir');
        if ((await readlink(path)) !== target)
          throw refuse(`Link was not created as signed: ${rel}`);
      }
    }
    await checkMetadata(staging, manifest);
    await writeFile(join(staging, MANIFEST), verified.bytes, { flag: 'wx' });
    await writeFile(join(staging, SIGNATURE), verified.signature, { flag: 'wx' });
    return { staging, final };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function commitStaging(root, { staging, final }, now) {
  // A leftover from an earlier failed attempt is kept aside for diagnosis, never deleted.
  if (await exists(final))
    await renameRetry(final, await freeName(`${final}.superseded-${stamp(now)}`));
  await renameRetry(staging, final);
}

/**
 * The relative path of every entry of a tree with its kind and, for a file, the SHA-256 of its
 * content; links are not followed. Two trees with the same shape hold the same bytes by name.
 */
async function treeShape(path) {
  const shape = [];
  const walk = async (dir, prefix) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        shape.push(`${rel}/`);
        await walk(full, rel);
      } else if (entry.isFile()) shape.push(`${rel} ${await hashFile(full)}`);
      else shape.push(`${rel} (other)`);
    }
  };
  await walk(path, '');
  return shape.join('\n');
}

/**
 * With the changed state already moved aside, a folder at the state's name is either the restored
 * copy or one created since (an installer rerun, by hand). Only the restored copy may end the
 * journal: it is proven when no restore copy waits any more and it matches the pre-update copy
 * it was made from. Otherwise this throws and nothing is moved, copied or deleted.
 */
async function checkRestored({ stateDir, preCopy, restoring }) {
  const halt = (problem) =>
    new UpdateError('ROLLBACK_INCOMPLETE', `the state folder ${stateDir} ${problem}`);
  if (await exists(restoring))
    throw halt(
      `was created again while its restore was pending; the restored data is still in ${restoring}: move ${stateDir} aside without deleting anything, then run --recover again`,
    );
  if (!(await exists(preCopy)))
    throw halt(`cannot be proven restored: the pre-update copy ${preCopy} is missing`);
  if ((await treeShape(stateDir)) !== (await treeShape(preCopy)))
    throw halt(`cannot be proven restored: it does not match the pre-update copy ${preCopy}`);
}

/** Idempotent: moves the changed state aside (never deleted) and puts a fresh copy in its place. */
async function restoreState(root, journal) {
  if ((await exists(journal.stateDir)) && (await exists(journal.failedAside)))
    return checkRestored(journal);
  // The restore copy is only replaced by a new copy of the pre-update one: without it, it is kept.
  if ((await exists(journal.stateDir)) && !(await exists(journal.preCopy)))
    throw new UpdateError(
      'ROLLBACK_INCOMPLETE',
      `the pre-update copy ${journal.preCopy} is missing; nothing was moved or deleted`,
    );
  await writeJsonAtomic(join(root, JOURNAL), { ...journal, phase: 'restoring' });
  if ((await exists(journal.stateDir)) && !(await exists(journal.failedAside))) {
    await rm(journal.restoring, { recursive: true, force: true });
    await cp(journal.preCopy, journal.restoring, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await renameRetry(journal.stateDir, journal.failedAside);
  }
  if (!(await exists(journal.stateDir))) await renameRetry(journal.restoring, journal.stateDir);
}

/** Undo a journal: previous version current again, state restored if it may have changed. */
async function undo(root, journal) {
  const current = await readCurrent(root);
  if (current?.version !== journal.from.version)
    await writePointer(root, journal.from.version, journal.from.path, journal.from.adopted);
  if (STATE_AT_RISK.has(journal.phase)) await restoreState(root, journal);
  await rm(join(root, JOURNAL), { force: true });
}

function rollbackIncomplete(message, preCopy) {
  const error = new UpdateError(
    'ROLLBACK_INCOMPLETE',
    `${message}. Do not start SIPGES on this state folder: run --recover to retry, or restore it from the pre-update copy: ${preCopy}`,
  );
  error.preUpdateCopy = preCopy;
  return error;
}

async function recoverLocked(root) {
  const journal = await readJson(join(root, JOURNAL));
  if (!journal) return false;
  try {
    await undo(root, journal);
  } catch (undoError) {
    await log(root, {
      event: 'rollback-incomplete',
      from: journal.to.version,
      to: journal.from.version,
      phase: journal.phase,
      error: undoError.message,
    }).catch(() => {});
    throw rollbackIncomplete(
      `An interrupted update to ${journal.to.version} could not be rolled back (${undoError.message})`,
      journal.preCopy,
    );
  }
  await log(root, {
    event: 'recovered',
    from: journal.to.version,
    to: journal.from.version,
    phase: journal.phase,
  });
  return true;
}

/** Rolls back an interrupted update left by a crash. Returns the current version afterwards. */
export async function recover({ root }) {
  root = resolve(root);
  const unlock = await lock(root);
  try {
    const recovered = await recoverLocked(root);
    return { ...(await readCurrent(root)), recovered };
  } finally {
    await unlock();
  }
}

/**
 * The way out of a halted update (ROLLBACK_INCOMPLETE) after the person put their own backup
 * back in the state folder: the version from before the update becomes current again and the
 * pending journal is cleared. Nothing in or beside the state folder is copied, moved or deleted.
 * Refused while the state folder is missing, empty or not a real folder.
 */
export async function acceptRestoredState({ root }) {
  root = resolve(root);
  const unlock = await lock(root);
  try {
    const journal = await readJson(join(root, JOURNAL));
    if (!journal) return { ...(await readCurrent(root)), accepted: false };
    const { stateDir } = journal;
    const restoreFirst = (problem) =>
      refuse(`The state folder ${stateDir} ${problem}: restore your backup there first`);
    let info;
    try {
      info = await lstat(stateDir);
    } catch (error) {
      if (error.code === 'ENOENT') throw restoreFirst('does not exist');
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw restoreFirst('is not a folder');
    if ((await readdir(stateDir)).length === 0) throw restoreFirst('is empty');
    if ((await readCurrent(root))?.version !== journal.from.version)
      await writePointer(root, journal.from.version, journal.from.path, journal.from.adopted);
    await rm(join(root, JOURNAL), { force: true });
    await log(root, {
      event: 'restored-state-accepted',
      from: journal.to.version,
      to: journal.from.version,
      phase: journal.phase,
      stateDir,
    });
    return { ...(await readCurrent(root)), accepted: true };
  } finally {
    await unlock();
  }
}

/**
 * Refuses a state folder given as a link or junction, before anything is created: it would be
 * recorded as its target, such as the original folder a copy was meant to protect, and the first
 * start would migrate that one in place. A folder under a linked parent is still accepted.
 */
async function refuseLinkedState(stateDir) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) return; // checkStateDir refuses it
  let info;
  try {
    info = await lstat(resolve(stateDir));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink())
    throw refuse(
      `The state folder ${stateDir} is a link or junction: pass the real folder of the copy, never a link to it`,
    );
}

/** First install of a verified release; the trust key is supplied by the operator. */
export async function install({ root, release, stateDir, trustKey }) {
  root = resolve(root);
  release = resolve(release);
  await refuseLinkedState(stateDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const unlock = await lock(root);
  try {
    if (await readCurrent(root)) throw refuse('A version is already installed; use update');
    if (trustKey === undefined) throw refuse('The first install needs --trust-key');
    checkStateDir(root, stateDir);
    stateDir = await canonicalState(stateDir);
    checkStateDir(root, stateDir);
    const verified = await readRelease(release, loadPublicKey(trustKey));
    checkTarget(null, verified.manifest);
    await commitStaging(root, await stage(root, release, verified), new Date());
    await recordStateDir(root, stateDir);
    const version = verified.manifest.version;
    await writePointer(root, version, `${VERSIONS}/${version}`, false);
    await log(root, { event: 'installed', to: version });
    return { version };
  } finally {
    await unlock();
  }
}

/** Checks an old plain package for adoption; nothing is recorded until its release verified. */
async function checkAdoption(root, { dir, stateDir }, trustKey) {
  dir = resolve(dir);
  const metadata = await readJson(join(dir, 'metadata.json')).catch(() => null);
  if (!isVersion(metadata?.version) || !(await exists(join(dir, 'start.mjs'))))
    throw refuse(`${dir} is not a desktop package (metadata.json and start.mjs)`);
  if (inside(join(root, VERSIONS), dir)) throw refuse('The old install must be outside versions/');
  checkStateDir(root, stateDir);
  if (!(await exists(stateDir))) throw refuse(`The state folder does not exist: ${stateDir}`);
  stateDir = await canonicalState(stateDir);
  checkStateDir(root, stateDir);
  const existing = await readJson(join(root, INSTALL));
  if (existing && existing.stateDir !== stateDir)
    throw refuse(`This install already uses the state folder ${existing.stateDir}`);
  const key = await trustedKey(dir, trustKey);
  return { current: { version: metadata.version, dir, adopted: true }, key, stateDir };
}

async function recordAdoption(root, { current, stateDir }) {
  await recordStateDir(root, stateDir);
  await writePointer(root, current.version, current.dir, true);
  await log(root, { event: 'adopted', to: current.version, dir: current.dir });
}

/**
 * Verifies a local release and switches to it. `migrate` and `ready` receive
 * `{ versionDir, stateDir, version }`; `adopt: { dir, stateDir }` takes over an old plain package.
 * `expectVersion` refuses a release holding any other version; `statfs` is for tests.
 */
export async function update({
  root,
  release,
  migrate,
  ready,
  trustKey,
  adopt,
  onStep,
  now,
  expectVersion,
  statfs = fsStatfs,
}) {
  root = resolve(root);
  release = resolve(release);
  const clock = now ?? (() => new Date());
  const step = async (name) => onStep?.(name);
  if (adopt) await mkdir(root, { recursive: true, mode: 0o700 });
  else if (!(await exists(join(root, POINTER))))
    throw refuse('No installed version here: install one first or adopt an old one');
  const unlock = await lock(root);
  let journal = null;
  let at = 'recover';
  const saveJournal = async (phase) => {
    journal = { ...journal, phase };
    await writeJsonAtomic(join(root, JOURNAL), journal);
  };
  try {
    await step('locked');
    await recoverLocked(root);
    at = 'verify';
    let current = await readCurrent(root);
    let key;
    let stateDir;
    let adoption = null;
    if (adopt) {
      if (current) throw refuse('This install already has a current version; adopt only once');
      adoption = await checkAdoption(root, adopt, trustKey);
      ({ current, key, stateDir } = adoption);
    } else {
      key = await trustedKey(current.dir, trustKey);
      stateDir = await stateDirOf(root);
    }
    const verified = await readRelease(release, key);
    const { manifest } = verified;
    if (expectVersion !== undefined && manifest.version !== expectVersion)
      throw refuse(`The release holds ${manifest.version}, not the requested ${expectVersion}`);
    checkTarget(current, manifest);
    await checkStateRoom(stateDir, current.adopted ? 3 : 2, statfs);
    await step('verified');
    at = 'stage';
    const staged = await stage(root, release, verified);
    if (adoption) await recordAdoption(root, adoption);
    await step('staged');
    const date = clock();
    await commitStaging(root, staged, date);
    await step('installed');

    const [from, to, when] = [current.version, manifest.version, stamp(date)];
    const versionDir = staged.final;
    at = 'state copy';
    journal = {
      from: {
        version: from,
        path: current.adopted ? current.dir : `${VERSIONS}/${from}`,
        adopted: current.adopted,
      },
      to: { version: to, path: `${VERSIONS}/${to}` },
      stateDir,
      preCopy: await freeName(`${stateDir}.pre-update-${when}-${from}-to-${to}`),
      failedAside: await freeName(`${stateDir}.failed-${when}-${to}`),
      restoring: `${stateDir}.restoring-${when}-${randomUUID()}`,
    };
    await saveJournal('copying');
    await copyTree(stateDir, journal.preCopy);
    await step('state-copied');

    let rehearsal = null;
    if (current.adopted) {
      at = 'rehearsal';
      rehearsal = await freeName(`${stateDir}.rehearsal-${when}-${to}`);
      await copyTree(stateDir, rehearsal);
      try {
        await migrate({ versionDir, stateDir: rehearsal, version: to });
        await ready({ versionDir, stateDir: rehearsal, version: to });
      } catch (error) {
        throw Object.assign(error, { rehearsal: true });
      }
      await step('rehearsed');
    }

    at = 'migrate';
    await saveJournal('migrating');
    await migrate({ versionDir, stateDir, version: to });
    await step('migrated');

    at = 'switch';
    await saveJournal('switched');
    await writePointer(root, to, journal.to.path, false);
    await step('switched');

    at = 'ready';
    const live = await readCurrent(root);
    await ready({ versionDir: live.dir, stateDir, version: to });
    await step('ready');

    const preUpdateCopy = journal.preCopy;
    await rm(join(root, JOURNAL), { force: true });
    journal = null;
    await step('committed');
    await log(root, {
      event: 'updated',
      from,
      to,
      preUpdateCopy,
      ...(rehearsal ? { rehearsalCopy: rehearsal } : {}),
    });
    return { from, to, preUpdateCopy };
  } catch (error) {
    // A refusal after the journal exists (the state folder became a link before its copy)
    // still has to be undone like any other failure.
    if (!journal && ['REFUSED', 'BUSY', 'CORRUPT'].includes(error.code)) {
      await log(root, { event: 'refused', release, reason: error.message }).catch(() => {});
      throw error;
    }
    if (!journal) {
      // Nothing to undo (a full disk while staging): the install is unchanged, say why.
      await log(root, {
        event: 'failed',
        release,
        step: at,
        code: error.code ?? null,
        reason: error.message,
      }).catch(() => {});
      throw error;
    }
    const reason = error.message;
    const { from, to } = { from: journal.from.version, to: journal.to.version };
    try {
      await undo(root, journal);
    } catch (undoError) {
      await log(root, {
        event: 'rollback-incomplete',
        from,
        to,
        step: at,
        reason,
        error: undoError.message,
      }).catch(() => {});
      throw rollbackIncomplete(
        `Update to ${to} failed at ${at} and the rollback did not finish (${undoError.message})`,
        journal.preCopy,
      );
    }
    await log(root, { event: 'rolled-back', from, to, step: at, reason });
    if (error.rehearsal)
      throw new UpdateError(
        'ROLLED_BACK',
        `Update to ${to} failed at rehearsal on a copy of the state folder; the state folder was not touched: ${reason}`,
      );
    throw new UpdateError(
      'ROLLED_BACK',
      `Update to ${to} failed at ${at} and was rolled back to ${from}: ${reason}`,
    );
  } finally {
    await unlock();
  }
}

const FIRST_START = 'first-start.json';
const SECRETS = ['data-key', 'admin-password'];

async function hasContent(path) {
  try {
    return (await readFile(path, 'utf8')).trim() !== '';
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Whether the state folder already holds a database (an older install's data). */
async function holdsDatabase(stateDir) {
  try {
    return (await readdir(join(stateDir, 'pglite'))).length > 0;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * The first start of a managed install (closure-roadmap T33). A state folder that already holds
 * a database, such as the one of a clone-based install, is never migrated in place first: it is
 * copied beside itself as `<state>.pre-update-<UTC time>-first-start-<version>` (kept, never
 * deleted), the migration runs on a second copy `<state>.rehearsal-<time>-<version>`, and only
 * then on the state folder; a failure there restores it from the dated copy. A failure on the
 * rehearsal leaves the state folder untouched. Without its data key or admin password the
 * database is refused before anything is written: a new key would make its sealed values
 * unreadable. Done once per install (`first-start.json`); later calls change nothing.
 * `migrate` receives `{ versionDir, stateDir, version }`; `statfs` is for tests.
 */
export async function firstStart({ root, migrate, now, statfs = fsStatfs }) {
  root = resolve(root);
  const clock = now ?? (() => new Date());
  const unlock = await lock(root);
  let journal = null;
  let version;
  try {
    await recoverLocked(root);
    const current = await readCurrent(root);
    if (!current) throw new UpdateError('CORRUPT', 'No installed version here');
    version = current.version;
    if (await readJson(join(root, FIRST_START)))
      return { done: false, version, preUpdateCopy: null };
    const stateDir = await stateDirOf(root);
    let rehearsal = null;
    const record = async (preUpdateCopy) => {
      await writeJsonAtomic(join(root, FIRST_START), {
        format: 1,
        version,
        stateDir,
        preUpdateCopy,
        at: clock().toISOString(),
      });
      await log(root, {
        event: 'first-start',
        version,
        preUpdateCopy,
        ...(rehearsal ? { rehearsalCopy: rehearsal } : {}),
      });
      return { done: true, version, preUpdateCopy };
    };
    if (!(await holdsDatabase(stateDir))) return await record(null);
    for (const name of SECRETS)
      if (!(await hasContent(join(stateDir, name))))
        throw refuse(
          `The state folder holds a database but ${join(stateDir, name)} is missing or empty; restore it from the backup of this state folder before starting SIPGES`,
        );
    await checkStateRoom(stateDir, 3, statfs);
    const when = stamp(clock());
    const path = current.adopted ? current.dir : `${VERSIONS}/${version}`;
    journal = {
      kind: 'first-start',
      from: { version, path, adopted: current.adopted },
      to: { version, path },
      stateDir,
      preCopy: await freeName(`${stateDir}.pre-update-${when}-first-start-${version}`),
      failedAside: await freeName(`${stateDir}.failed-${when}-${version}`),
      restoring: `${stateDir}.restoring-${when}-${randomUUID()}`,
      phase: 'copying',
    };
    await writeJsonAtomic(join(root, JOURNAL), journal);
    await copyTree(stateDir, journal.preCopy);
    rehearsal = await freeName(`${stateDir}.rehearsal-${when}-${version}`);
    await copyTree(stateDir, rehearsal);
    try {
      await migrate({ versionDir: current.dir, stateDir: rehearsal, version });
    } catch (error) {
      // Only copies were handed to the migration: nothing to undo.
      await rm(join(root, JOURNAL), { force: true });
      journal = null;
      throw new UpdateError(
        'ROLLED_BACK',
        `The first start of ${version} failed on a copy of the state folder; the state folder was not touched: ${error.message}`,
      );
    }
    journal = { ...journal, phase: 'migrating' };
    await writeJsonAtomic(join(root, JOURNAL), journal);
    await migrate({ versionDir: current.dir, stateDir, version });
    const preUpdateCopy = journal.preCopy;
    await rm(join(root, JOURNAL), { force: true });
    journal = null;
    return await record(preUpdateCopy);
  } catch (failure) {
    let error = failure;
    if (journal) {
      try {
        await undo(root, journal);
      } catch (undoError) {
        await log(root, {
          event: 'rollback-incomplete',
          from: version,
          to: version,
          step: 'first-start',
          reason: error.message,
          error: undoError.message,
        }).catch(() => {});
        throw rollbackIncomplete(
          `The first start of ${version} failed and the state folder could not be restored (${undoError.message})`,
          journal.preCopy,
        );
      }
      error = new UpdateError(
        'ROLLED_BACK',
        STATE_AT_RISK.has(journal.phase)
          ? `The first start of ${version} failed and the state folder was restored from ${journal.preCopy}: ${error.message}`
          : `The first start of ${version} failed before any migration; the state folder was not touched: ${error.message}`,
      );
    }
    if (version !== undefined)
      await log(root, {
        event: 'first-start-failed',
        version,
        code: error.code ?? null,
        reason: error.message,
      }).catch(() => {});
    throw error;
  } finally {
    await unlock();
  }
}

// The copies the updater leaves beside the state folder, named `<state>.<kind>-<UTC time>-…`.
// None is ever deleted automatically: they hold the data and its key.
const COPY_KINDS = ['pre-update', 'rehearsal', 'failed'];
const DAY_MS = 86_400_000;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The time in a copy's name (`20261111T102030Z`), as a Date. */
const stampDate = (text) =>
  new Date(
    `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(9, 11)}:${text.slice(11, 13)}:${text.slice(13, 15)}Z`,
  );

async function treeBytes(path) {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) bytes += await treeBytes(full);
    else bytes += (await lstat(full)).size;
  }
  return bytes;
}

/**
 * The copies beside the recorded state folder, oldest first: `{ stateDir, copies, count, bytes,
 * newestPreUpdate }`; each copy is `{ kind, path, at, bytes }`. Only finished folders named by
 * the updater count (not `.partial` copies, links, files or other folders).
 */
export async function listStateCopies({ root }) {
  const stateDir = await stateDirOf(resolve(root));
  const parent = dirname(stateDir);
  const pattern = new RegExp(
    `^${escapeRegExp(basename(stateDir))}\\.(${COPY_KINDS.join('|')})-(\\d{8}T\\d{6}Z)(-.*)?$`,
  );
  let names;
  try {
    names = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') names = [];
    else throw error;
  }
  const copies = [];
  for (const entry of names) {
    const match = pattern.exec(entry.name);
    if (!match || entry.name.endsWith('.partial') || !entry.isDirectory()) continue;
    const path = join(parent, entry.name);
    copies.push({ kind: match[1], path, at: stampDate(match[2]), bytes: await treeBytes(path) });
  }
  copies.sort((a, b) => a.at - b.at || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const preUpdate = copies.filter((copy) => copy.kind === 'pre-update');
  return {
    stateDir,
    copies,
    count: copies.length,
    bytes: copies.reduce((sum, copy) => sum + copy.bytes, 0),
    newestPreUpdate: preUpdate.at(-1)?.path ?? null,
  };
}

/**
 * The explicit clean-up: removes the copies whose name is older than `olderThanDays` whole days,
 * except the newest pre-update copy, which is never removed (it is the way back from the last
 * update). Refused while an update or first start is pending or halted, since its journal may
 * need any of them. Returns `{ removed, kept, left }`; logs `copies-removed`.
 */
export async function removeStateCopies({ root, olderThanDays, now }) {
  root = resolve(root);
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1)
    throw refuse('The age of the copies to remove must be a whole number of days, 1 or more');
  const unlock = await lock(root);
  try {
    if (await exists(join(root, JOURNAL)))
      throw refuse(
        'An update is pending or halted; its copies may be needed. Run --recover first (or restore the state folder and --accept-restored-state), then remove copies.',
      );
    const listed = await listStateCopies({ root });
    const limit = (now ?? new Date()).getTime() - olderThanDays * DAY_MS;
    const old = listed.copies.filter((copy) => copy.at.getTime() < limit);
    const kept = old.find((copy) => copy.path === listed.newestPreUpdate)?.path ?? null;
    const removed = old.filter((copy) => copy.path !== listed.newestPreUpdate);
    for (const copy of removed) await rm(copy.path, { recursive: true });
    if (removed.length || kept)
      await log(root, {
        event: 'copies-removed',
        olderThanDays,
        removed: removed.map((copy) => copy.path),
        kept,
      });
    return { removed, kept, left: listed.count - removed.length };
  } finally {
    await unlock();
  }
}
