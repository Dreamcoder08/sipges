// Managed desktop startup: runs the current version of an install root, checks the local release
// source once at startup, and applies a verified update only when the person clicks «Actualizar».
//
//   <root>/update-channel/status.json   written here: installed version and the verified update
//   <root>/update-channel/request.json  written by the API after the click (admin only)
//
// The API never decides what to install: a request names a version, and only the release this
// launcher verified for that version is applied, through `update` (verified again, with rollback).
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { bootCheck, managedEnv } from './boot.mjs';
import { findUpdate, readCurrent, readStateDir, recover, update } from './updater.mjs';

export const CHANNEL = 'update-channel';
const STATUS = 'status.json';
const REQUEST = 'request.json';
const STOP_GRACE_MS = 15_000;

const jsonLine = (event, fields) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

async function hasContent(path) {
  try {
    return (await readFile(path, 'utf8')).trim() !== '';
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Creates the state folder and each missing secret once, like deploy/desktop/linux
 * (`--prepare`): an existing secret is never rewritten, a blank one is replaced.
 */
export async function prepareState(stateDir) {
  await mkdir(join(stateDir, 'pglite'), { recursive: true, mode: 0o700 });
  await mkdir(join(stateDir, 'uploads'), { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const secrets = {
    'data-key': () => randomBytes(32).toString('base64'),
    'admin-password': () => randomBytes(18).toString('base64url'),
  };
  for (const [name, make] of Object.entries(secrets)) {
    const path = join(stateDir, name);
    if (!(await hasContent(path))) await writeFile(path, `${make()}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }
}

const withTimeout = (work, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Starts the current version and keeps it running. Options other than `root` are for tests and
 * the CLI: `source` (local release directory; unset disables the check), `migrate`/`ready`
 * (defaults boot the new version on a free port, as update.mjs does) and `find`.
 * Returns `{ done, stop, checked }`: `done` resolves with the exit code when SIPGES stops.
 */
export async function launch({
  root,
  source,
  port = 8000,
  log = jsonLine,
  checkTimeoutMs = 10_000,
  pollMs = 500,
  find = findUpdate,
  migrate,
  ready,
  baseEnv = process.env,
}) {
  root = resolve(root);
  const recovered = await recover({ root });
  if (recovered.recovered) log('update_recovered', { version: recovered.version });
  const stateDir = await readStateDir(root);
  await prepareState(stateDir);
  const channel = join(root, CHANNEL);
  await mkdir(channel, { recursive: true, mode: 0o700 });
  // A click from an earlier run never updates on this start.
  await rm(join(channel, REQUEST), { force: true });
  const check = bootCheck({ logFile: join(root, 'update-boot.log') });
  migrate ??= check;
  ready ??= check;

  let verified = null;
  let poller;
  let child = null;
  let stopping = false;
  let updating = false;
  let finish;
  const done = new Promise((resolveDone) => (finish = resolveDone));

  const publish = (installed) =>
    writeJsonAtomic(join(channel, STATUS), {
      format: 1,
      installed,
      available: verified && { version: verified.version, notes: verified.notes },
      checkedAt: new Date().toISOString(),
    });

  const start = async () => {
    const current = await readCurrent(root);
    const env = await managedEnv({ versionDir: current.dir, stateDir, port, base: baseEnv });
    env.SIPGES_DESKTOP_UPDATE_DIR = channel;
    const started = spawn(process.execPath, [join(current.dir, 'start.mjs')], {
      cwd: current.dir,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    started.on('exit', (code, signal) => {
      if (child !== started) return;
      child = null;
      if (updating) return;
      // Stopped by the person or by its own failure: the launcher ends with it.
      clearInterval(poller);
      finish(stopping ? 0 : (code ?? (signal ? 1 : 0)));
    });
    child = started;
    log('started', { version: current.version, port });
    return current;
  };

  const stopChild = async () => {
    const running = child;
    if (!running) return;
    const exited = once(running, 'exit');
    running.kill('SIGTERM');
    if ((await Promise.race([exited.then(() => true), sleep(STOP_GRACE_MS)])) !== true) {
      running.kill('SIGKILL');
      await exited;
    }
  };

  const apply = async (version) => {
    updating = true;
    const release = verified.release;
    log('update_started', { version });
    await stopChild();
    child = null;
    try {
      const result = await update({ root, release, migrate, ready });
      log('updated', { from: result.from, to: result.to, preUpdateCopy: result.preUpdateCopy });
    } catch (error) {
      log('update_failed', { version, code: error.code ?? null, reason: error.message });
    }
    verified = null;
    const current = await readCurrent(root);
    await publish(current.version);
    updating = false;
    if (stopping) {
      clearInterval(poller);
      return finish(0);
    }
    await start();
  };

  const takeRequest = async () => {
    const path = join(channel, REQUEST);
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    await rm(path, { force: true });
    let version;
    try {
      version = JSON.parse(text).version ?? null;
    } catch {
      version = null;
    }
    if (!verified || version !== verified.version) {
      log('update_request_ignored', { version, verified: verified?.version ?? null });
      return;
    }
    await apply(version);
  };

  const current = await readCurrent(root);
  await publish(current.version);
  await start();

  let polling = false;
  poller = setInterval(() => {
    if (polling || updating || stopping) return;
    polling = true;
    takeRequest()
      .catch((error) => log('update_request_failed', { reason: error.message }))
      .finally(() => (polling = false));
  }, pollMs);

  // The check runs beside the server and never delays or stops it: one line whatever happens.
  const checked = source
    ? withTimeout(find({ root, source }), checkTimeoutMs)
        .then(async (result) => {
          if (updating || stopping) return;
          verified = result.available;
          await publish(result.installed);
          log('update_check', {
            installed: result.installed,
            available: result.available?.version ?? null,
            skipped: result.skipped.map((s) => s.reason),
          });
        })
        .catch((error) => log('update_check_failed', { reason: error.message }))
    : Promise.resolve();

  const stop = async () => {
    if (stopping) return done;
    stopping = true;
    if (!updating) {
      clearInterval(poller);
      await stopChild();
      finish(0);
    }
    return done;
  };

  return { done, stop, checked };
}

const USAGE = `Usage: node <version>/updater/launcher.mjs --install <root> [--releases <dir>] [--port <port>]

Starts the current version of a managed install on 127.0.0.1 (default port 8000), checks
<dir> for a newer signed release at startup and offers it in the app. Updates run only after
an administrator clicks «Actualizar». Without --releases no check is made.`;

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(USAGE);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const [key, value] = [args[i], args[i + 1]];
    if (
      !['--install', '--releases', '--port'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      options[key]
    )
      throw new Error('Invalid options; use --help');
    options[key] = value;
  }
  if (!options['--install']) throw new Error('Missing --install');
  const port = options['--port'] === undefined ? 8000 : Number(options['--port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port');
  const running = await launch({
    root: options['--install'],
    source: options['--releases'] ? resolve(options['--releases']) : undefined,
    port,
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void running.stop());
  process.exitCode = await running.done;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
