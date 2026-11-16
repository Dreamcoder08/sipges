// Managed desktop startup: runs the current version of an install root, checks the local release
// source once at startup, and applies a verified update only when the person clicks «Actualizar».
//
//   <root>/update-channel/status.json   written here: installed version and the verified update
//   <root>/update-channel/request.json  written by the API after the click (admin only)
//
// The API never decides what to install: a request names a version, and only the release this
// launcher verified for that version is applied, through `update` (verified again, with rollback).
/* global AbortController */
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
import { PARENT_WATCH, bootCheck, managedEnv } from './boot.mjs';
import {
  findUpdate,
  firstStart,
  listStateCopies,
  readCurrent,
  readStateDir,
  recover,
  update,
} from './updater.mjs';

export const CHANNEL = 'update-channel';
/** Exit code when an update could not be rolled back: nothing is started on that state. */
export const ROLLBACK_INCOMPLETE_EXIT = 3;
/** Exit code after a second stop signal forced the server down without its graceful stop. */
export const FORCED_EXIT = 1;
const ROLLBACK_INCOMPLETE = 'ROLLBACK_INCOMPLETE';
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

/** What the person reads in the console or shortcut window when SIPGES must not start. */
export const haltNotice = (preUpdateCopy) =>
  `SIPGES no se inició: una actualización falló y sus datos no se pudieron restaurar. No borre nada. Restaure la copia de seguridad ${preUpdateCopy ?? 'previa a la actualización (junto a la carpeta de datos)'} o contacte con soporte.`;

/**
 * What the person reads when the first start over existing data was refused or failed. Only a
 * rollback that did not finish (ROLLBACK_INCOMPLETE) needs a restore; otherwise the data folder
 * is as it was and the old version can keep using it.
 */
export const firstStartNotice = (error) =>
  error.code === ROLLBACK_INCOMPLETE
    ? haltNotice(error.preUpdateCopy)
    : `SIPGES no se inició: la versión nueva no pudo abrir los datos existentes. Sus datos no se tocaron. No borre nada y contacte con soporte (detalle en launcher.log).`;

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
 * `signal` (an AbortSignal) is the stop that may arrive before this returns, during the first
 * start: its boot child is ended and awaited, the folder is restored, and the launch ends as
 * stopped. Returns `{ done, stop, checked }`: `done` resolves with the exit code when SIPGES stops.
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
  signal,
}) {
  root = resolve(root);
  // One stop for every boot child this launch starts (first start, rehearsal, update).
  const halt = new AbortController();
  if (signal?.aborted) halt.abort();
  else signal?.addEventListener('abort', () => halt.abort(), { once: true });
  const stoppedEarly = () => ({
    done: Promise.resolve(0),
    stop: async () => 0,
    kill: () => {},
    checked: Promise.resolve(),
    halted: () => null,
  });
  let recovered;
  try {
    recovered = await recover({ root });
  } catch (error) {
    // The state may be half-migrated: starting any version on it would write on top of it.
    if (error.code === ROLLBACK_INCOMPLETE)
      log('start_refused', {
        code: error.code,
        reason: error.message,
        action: haltNotice(error.preUpdateCopy),
      });
    throw error;
  }
  if (recovered.recovered) log('update_recovered', { version: recovered.version });
  const check = bootCheck({ logFile: join(root, 'update-boot.log'), signal: halt.signal });
  migrate ??= check;
  ready ??= check;
  // Existing data (an older install's state folder) opens only through a copy and a rehearsal,
  // and before anything below could create a secret in that folder.
  try {
    const first = await firstStart({ root, migrate });
    // One line only when existing data was carried; a fresh state folder needs no copy.
    if (first.preUpdateCopy)
      log('first_start', { version: first.version, preUpdateCopy: first.preUpdateCopy });
  } catch (error) {
    // Stopped during the first start: its boot child is gone and the folder was put back, so
    // this is a normal stop and the next start runs the first start again. Only a restore that
    // did not finish halts.
    if (halt.signal.aborted && error.code !== ROLLBACK_INCOMPLETE) {
      log('first_start_cancelled', { code: error.code ?? null, reason: error.message });
      return stoppedEarly();
    }
    log('start_refused', {
      code: error.code ?? null,
      reason: error.message,
      action: firstStartNotice(error),
    });
    throw Object.assign(error, { firstStart: true });
  }
  if (halt.signal.aborted) return stoppedEarly();
  const stateDir = await readStateDir(root);
  await prepareState(stateDir);
  const channel = join(root, CHANNEL);
  await mkdir(channel, { recursive: true, mode: 0o700 });
  // A click from an earlier run never updates on this start.
  await rm(join(channel, REQUEST), { force: true });

  let verified = null;
  let halted = null;
  let poller;
  let child = null;
  let stopping = false;
  let updating = false;
  let finish;
  const done = new Promise((resolveDone) => (finish = resolveDone));

  const writeStatus = (installed) =>
    writeJsonAtomic(join(channel, STATUS), {
      format: 1,
      installed,
      available: verified && { version: verified.version, notes: verified.notes },
      checkedAt: new Date().toISOString(),
    });
  // The status only feeds the notice in the app: failing to write it never stops SIPGES.
  const publish = (installed) =>
    writeStatus(installed).catch((error) => log('status_write_failed', { reason: error.message }));

  /** How many copies the updater left beside the state folder, and their total size. */
  const copiesNow = () =>
    listStateCopies({ root }).then(
      ({ count, bytes }) => ({ count, bytes }),
      () => null,
    );

  const start = async () => {
    const current = await readCurrent(root);
    const env = await managedEnv({
      versionDir: current.dir,
      stateDir,
      port,
      channel,
      base: baseEnv,
    });
    // The server watches a pipe from this launcher and ends when the launcher is gone, however
    // it ended (a forced stop, a hard kill, Windows), so no server outlives its launcher.
    const started = spawn(
      process.execPath,
      ['--import', PARENT_WATCH, join(current.dir, 'start.mjs')],
      {
        cwd: current.dir,
        env,
        stdio: ['pipe', 'inherit', 'inherit'],
        windowsHide: true,
      },
    );
    started.stdin.on('error', () => {});
    started.on('exit', (code, signal) => {
      if (child !== started) return;
      child = null;
      if (updating) return;
      // Stopped by the person or by its own failure: the launcher ends with it.
      clearInterval(poller);
      finish(stopping ? 0 : (code ?? (signal ? 1 : 0)));
    });
    child = started;
    // Counted beside the starting server, never before it: one field of the `started` line.
    log('started', { version: current.version, port, stateCopies: await copiesNow() });
    return current;
  };

  const stopChild = async () => {
    const running = child;
    if (!running) return;
    const exited = once(running, 'exit');
    running.kill('SIGTERM');
    // Unreferenced: the grace timer must not keep the launcher alive after the server exited.
    const grace = sleep(STOP_GRACE_MS, undefined, { ref: false });
    if ((await Promise.race([exited.then(() => true), grace])) !== true) {
      running.kill('SIGKILL');
      await exited;
    }
  };

  /** The release folder must still hold exactly the version verified at startup. */
  const stillVerified = async (version, release) => {
    try {
      const again = await withTimeout(find({ root, source: release }), checkTimeoutMs);
      if (again.available?.version === version && again.available.release === release) return null;
    } catch (error) {
      return error.message;
    }
    return `The release folder no longer holds the verified version ${version}: ${release}`;
  };

  const apply = async (version) => {
    const release = verified.release;
    const refused = await stillVerified(version, release);
    // SIPGES was stopped during the re-check: the click no longer counts.
    if (stopping) {
      log('update_cancelled', { version });
      return;
    }
    if (refused) {
      verified = null;
      await publish((await readCurrent(root)).version);
      log('update_request_refused', { version, reason: refused });
      return;
    }
    updating = true;
    log('update_started', { version });
    await stopChild();
    child = null;
    try {
      const result = await update({ root, release, migrate, ready, expectVersion: version });
      log('updated', { from: result.from, to: result.to, preUpdateCopy: result.preUpdateCopy });
    } catch (error) {
      const fields = { version, code: error.code ?? null, reason: error.message };
      if (error.code === ROLLBACK_INCOMPLETE) {
        // Never start a version on a state folder that was not restored.
        halted = haltNotice(error.preUpdateCopy);
        log('update_failed', { ...fields, action: halted });
        clearInterval(poller);
        return finish(ROLLBACK_INCOMPLETE_EXIT);
      }
      log('update_failed', fields);
    }
    verified = null;
    // From here SIPGES runs again or the launcher ends: never left without a server and still
    // `updating`, where neither a request nor a stop would do anything.
    let current = null;
    try {
      current = await readCurrent(root);
      await publish(current.version);
      updating = false;
      if (stopping) {
        clearInterval(poller);
        return finish(0);
      }
      await start();
    } catch (error) {
      updating = false;
      clearInterval(poller);
      log('start_failed', { version: current?.version ?? null, reason: error.message });
      await stopChild();
      finish(stopping ? 0 : 1);
    }
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
    // A boot running for an update is ended now; the update then rolls back.
    halt.abort();
    if (!updating) {
      clearInterval(poller);
      await stopChild();
      finish(0);
    }
    return done;
  };

  /** The second stop: the server is killed now, without waiting for its graceful stop. */
  const kill = () => {
    stopping = true;
    halt.abort();
    clearInterval(poller);
    child?.kill('SIGKILL');
  };

  return { done, stop, kill, checked, halted: () => halted };
}

const USAGE = `Usage: node <version>/updater/launcher.mjs --install <root> [--releases <dir>] [--port <port>]

Starts the current version of a managed install on 127.0.0.1 (default port 8000), checks
<dir> for a newer signed release at startup and offers it in the app. Updates run only after
an administrator clicks «Actualizar». Without --releases no check is made.
A first SIGINT or SIGTERM stops SIPGES gracefully (up to 15 s); a second one kills the server at
once and exits with code 1.
Exit codes: 0 stopped, 3 an update could not be rolled back and nothing was started (restore
the pre-update copy named in the message), otherwise the server's own exit code or 1.`;

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
  // Registered before anything starts: a stop during the first start must end its boot child.
  // The first SIGINT or SIGTERM stops gracefully; a second one forces: the server is killed at
  // once and the launcher exits, and every boot child ends with its pipe from this process.
  const stop = new AbortController();
  let running = null;
  let signals = 0;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      signals += 1;
      if (signals === 1) {
        stop.abort();
        if (running) void running.stop();
        return;
      }
      running?.kill();
      jsonLine('stop_forced', { signal });
      process.exit(FORCED_EXIT);
    });
  running = await launch({
    root: options['--install'],
    source: options['--releases'] ? resolve(options['--releases']) : undefined,
    port,
    signal: stop.signal,
  });
  if (stop.signal.aborted) void running.stop();
  process.exitCode = await running.done;
  if (running.halted()) console.error(running.halted());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    if (error.code === ROLLBACK_INCOMPLETE) {
      console.error(haltNotice(error.preUpdateCopy));
      console.error(`Detalle: ${error.message}`);
      process.exitCode = ROLLBACK_INCOMPLETE_EXIT;
      return;
    }
    if (error.firstStart) console.error(firstStartNotice(error));
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
