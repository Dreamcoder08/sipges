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
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
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

// Windows refuses a rename while another process (an antivirus scan) briefly holds the file.
async function renameRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (error) {
      const transient = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (process.platform !== 'win32' || !transient || attempt >= 20) throw error;
      await sleep(100);
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

async function lock(root) {
  const path = join(root, LOCK);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, time: new Date().toISOString() }),
        );
      } finally {
        await handle.close();
      }
      return async () => rm(path, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const held = await readJson(path).catch(() => null);
      if (held && alive(held.pid))
        throw new UpdateError('BUSY', `Another update is running (process ${held.pid})`);
      // The process that held it is gone: a crashed update. The journal decides what to undo.
      await rm(path, { force: true });
    }
  }
  throw new UpdateError('BUSY', 'Could not take the update lock');
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

async function stateDirOf(root) {
  const config = await readJson(join(root, INSTALL));
  if (!config || typeof config.stateDir !== 'string' || !isAbsolute(config.stateDir))
    throw new UpdateError('CORRUPT', `${INSTALL} is missing or invalid`);
  return config.stateDir;
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

/** Copies exactly the signed files into a staging folder, hashing the copy, not the source. */
async function stage(root, releaseDir, verified) {
  const { manifest } = verified;
  const versions = join(root, VERSIONS);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  const staging = join(versions, `.staging-${randomUUID()}`);
  const final = join(versions, manifest.version);
  const source = join(releaseDir, 'package');
  try {
    const scan = await scanTree(source);
    const compare = (found, expected) => {
      const actual = [...found];
      const wanted = new Set(expected);
      for (const path of [...actual].sort())
        if (!wanted.has(path))
          throw refuse(`The release package does not match its manifest: unlisted ${path}`);
      const present = new Set(actual);
      for (const path of [...expected].sort())
        if (!present.has(path))
          throw refuse(`The release package does not match its manifest: missing ${path}`);
    };
    compare(scan.files.keys(), Object.keys(manifest.files));
    compare(scan.links.keys(), Object.keys(manifest.links));
    compare(scan.directories, manifest.directories);
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

/** Idempotent: moves the changed state aside (never deleted) and puts a fresh copy in its place. */
async function restoreState(root, journal) {
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

async function recoverLocked(root) {
  const journal = await readJson(join(root, JOURNAL));
  if (!journal) return false;
  await undo(root, journal);
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

/** First install of a verified release; the trust key is supplied by the operator. */
export async function install({ root, release, stateDir, trustKey }) {
  root = resolve(root);
  release = resolve(release);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const unlock = await lock(root);
  try {
    if (await readCurrent(root)) throw refuse('A version is already installed; use update');
    if (trustKey === undefined) throw refuse('The first install needs --trust-key');
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

async function adoptLegacy(root, { dir, stateDir }, trustKey) {
  dir = resolve(dir);
  const metadata = await readJson(join(dir, 'metadata.json')).catch(() => null);
  if (!isVersion(metadata?.version) || !(await exists(join(dir, 'start.mjs'))))
    throw refuse(`${dir} is not a desktop package (metadata.json and start.mjs)`);
  if (inside(join(root, VERSIONS), dir)) throw refuse('The old install must be outside versions/');
  checkStateDir(root, stateDir);
  if (!(await exists(stateDir))) throw refuse(`The state folder does not exist: ${stateDir}`);
  const key = await trustedKey(dir, trustKey);
  await recordStateDir(root, stateDir);
  await writePointer(root, metadata.version, dir, true);
  await log(root, { event: 'adopted', to: metadata.version, dir });
  return { current: await readCurrent(root), key };
}

/**
 * Verifies a local release and switches to it. `migrate` and `ready` receive
 * `{ versionDir, stateDir, version }`; `adopt: { dir, stateDir }` takes over an old plain package.
 */
export async function update({ root, release, migrate, ready, trustKey, adopt, onStep, now }) {
  root = resolve(root);
  release = resolve(release);
  const clock = now ?? (() => new Date());
  const step = async (name) => onStep?.(name);
  if (adopt) await mkdir(root, { recursive: true, mode: 0o700 });
  else if (!(await exists(join(root, POINTER))))
    throw refuse('No installed version here: install one first or adopt an old one');
  const unlock = await lock(root);
  let journal = null;
  let at = 'verify';
  const saveJournal = async (phase) => {
    journal = { ...journal, phase };
    await writeJsonAtomic(join(root, JOURNAL), journal);
  };
  try {
    await step('locked');
    await recoverLocked(root);
    let current = await readCurrent(root);
    let key;
    if (adopt) {
      if (current) throw refuse('This install already has a current version; adopt only once');
      ({ current, key } = await adoptLegacy(root, adopt, trustKey));
    } else key = await trustedKey(current.dir, trustKey);
    const stateDir = await stateDirOf(root);
    const verified = await readRelease(release, key);
    const { manifest } = verified;
    checkTarget(current, manifest);
    if (!(await exists(stateDir))) throw refuse(`The state folder does not exist: ${stateDir}`);
    await step('verified');
    const staged = await stage(root, release, verified);
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

    if (current.adopted) {
      at = 'rehearsal';
      const rehearsal = await freeName(`${stateDir}.rehearsal-${when}-${to}`);
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
    await log(root, { event: 'updated', from, to, preUpdateCopy });
    return { from, to, preUpdateCopy };
  } catch (error) {
    if (error.code === 'REFUSED' || error.code === 'BUSY' || error.code === 'CORRUPT') {
      await log(root, { event: 'refused', release, reason: error.message }).catch(() => {});
      throw error;
    }
    if (!journal) throw error;
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
      throw new UpdateError(
        'ROLLBACK_INCOMPLETE',
        `Update to ${to} failed at ${at} and the rollback did not finish (${undoError.message}); run --recover. Pre-update copy: ${journal.preCopy}`,
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
