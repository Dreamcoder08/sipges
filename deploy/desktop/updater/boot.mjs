// Real migration and readiness for the CLI: boot the version's start.mjs against a state folder
// on a free loopback port, wait for /health/ready and the web shell, then stop it. The API
// applies forward migrations at boot, so the first boot is the migration. The update and launcher
// tests inject their own migration and readiness; boot.test.mjs runs this with a synthetic version.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, readFile, stat } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

const status = (url, headers = {}) =>
  new Promise((resolve) => {
    const request = get(url, { headers, timeout: 2000 }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(0));
  });

async function secret(stateDir, name) {
  const value = (await readFile(join(stateDir, name), 'utf8')).trim();
  if (!value) throw new Error(`${name} is empty in the state folder`);
  return value;
}

/**
 * The only SIPGES_* variables a managed server sees: the allow-list of what the launcher owns.
 * SIPGES_DESKTOP_UPDATE_DIR is set only by the running launcher, not by the migration boot.
 */
export const LAUNCHER_ENV = Object.freeze([
  'SIPGES_ADMIN_PASSWORD',
  'SIPGES_COOKIE_SECURE',
  'SIPGES_DATA_KEY',
  'SIPGES_DESKTOP_UPDATE_DIR',
  'SIPGES_HOST',
  'SIPGES_PGLITE_DIR',
  'SIPGES_PORT',
  'SIPGES_REFERENCE_DIR',
  'SIPGES_UPLOAD_DIR',
  'SIPGES_WEB_DIR',
]);

/**
 * The environment a managed version runs with: secrets from the state folder, loopback only,
 * plain-HTTP cookies, data under the state folder, and the web app and reference files inside
 * the version (the folder the package's start.mjs defaults to). No inherited SIPGES_* setting
 * reaches it, in any letter case (Windows names are case-insensitive): only LAUNCHER_ENV, so the
 * server and the migration boot see the same configuration.
 */
export async function managedEnv({ versionDir, stateDir, port, channel, base = process.env }) {
  const owned = {
    SIPGES_DATA_KEY: await secret(stateDir, 'data-key'),
    SIPGES_ADMIN_PASSWORD: await secret(stateDir, 'admin-password'),
    SIPGES_COOKIE_SECURE: '0',
    SIPGES_HOST: '127.0.0.1',
    SIPGES_PORT: String(port),
    SIPGES_PGLITE_DIR: join(stateDir, 'pglite'),
    SIPGES_UPLOAD_DIR: join(stateDir, 'uploads'),
    SIPGES_WEB_DIR: join(versionDir, 'web'),
    SIPGES_REFERENCE_DIR: join(versionDir, 'references'),
    ...(channel ? { SIPGES_DESKTOP_UPDATE_DIR: channel } : {}),
  };
  for (const key of Object.keys(owned))
    if (!LAUNCHER_ENV.includes(key)) throw new Error(`${key} is not a launcher variable`);
  const inherited = Object.entries(base).filter(
    ([key]) => !key.toUpperCase().startsWith('SIPGES_'),
  );
  return { ...Object.fromEntries(inherited), ...owned };
}

export { freePort, status as httpStatus };

/**
 * Loaded before the version's start.mjs in every boot child: its stdin is a pipe from the process
 * that started it, and that pipe ends when that process is gone, however it ended (a hard kill
 * runs no handler, and Windows has no SIGTERM). The child then ends too, so a migration boot
 * never keeps writing a state folder that the next start restores from its copy.
 */
export const PARENT_WATCH = `data:text/javascript,${encodeURIComponent(
  "import process from 'node:process';" +
    "process.stdin.on('end', () => process.exit(70));" +
    "process.stdin.on('error', () => process.exit(70));" +
    'process.stdin.resume();',
)}`;

const stopped = () => Object.assign(new Error('SIPGES was stopped'), { code: 'STOPPED' });

/** Ports tried in one boot: the free port is released before the version binds it. */
const PORT_ATTEMPTS = 5;
const portTaken = (port) =>
  Object.assign(new Error(`the port ${port} was in use when the new version started`), {
    code: 'EADDRINUSE',
  });

/** Whether the boot child's own output (from `offset` on in the log) says its port was taken. */
async function reportsPortInUse(logFile, offset) {
  const bytes = await readFile(logFile).catch(() => Buffer.alloc(0));
  return bytes.subarray(offset).toString('utf8').includes('EADDRINUSE');
}

/**
 * Returns `({ versionDir, stateDir }) => Promise<void>` that boots, checks and stops. `signal`
 * (an AbortSignal) stops a running boot: the child is ended and awaited before the returned
 * promise rejects with code STOPPED, so nothing writes the state folder after that. The free port
 * is closed again before the version binds it, so another program can take it in between: a
 * version that ends with EADDRINUSE is booted again on another port, at most PORT_ATTEMPTS times.
 * `pickPort` is for tests.
 */
export function bootCheck({ logFile, timeoutMs = 120_000, signal, pickPort = freePort }) {
  const boot = bootOnce({ logFile, timeoutMs, signal });
  return async (target) => {
    let port;
    for (let attempt = 1; attempt <= PORT_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) throw stopped();
      port = await pickPort();
      try {
        return await boot(target, port);
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error(
      `the port ${port} was in use at each of ${PORT_ATTEMPTS} attempts to start the new version; see ${logFile}`,
    );
  };
}

function bootOnce({ logFile, timeoutMs, signal }) {
  return async ({ versionDir, stateDir }, port) => {
    if (signal?.aborted) throw stopped();
    const env = await managedEnv({ versionDir, stateDir, port });
    const output = await open(logFile, 'a', 0o600);
    const offset = (await stat(logFile)).size;
    const child = spawn(
      process.execPath,
      ['--import', PARENT_WATCH, join(versionDir, 'start.mjs')],
      {
        cwd: versionDir,
        env,
        stdio: ['pipe', output.fd, output.fd],
        windowsHide: true,
      },
    );
    child.stdin.on('error', () => {});
    let exited = null;
    child.on('exit', (code, signal) => (exited = { code, signal }));
    const exit = once(child, 'exit');
    const aborted = new Promise((resolveAbort) => {
      if (signal) signal.addEventListener('abort', resolveAbort, { once: true });
    });
    try {
      const deadline = Date.now() + timeoutMs;
      const base = `http://127.0.0.1:${port}`;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw stopped();
        if (exited) {
          if (await reportsPortInUse(logFile, offset)) throw portTaken(port);
          throw new Error(
            `the new version stopped while starting (code ${exited.code}); see ${logFile}`,
          );
        }
        if ((await status(`${base}/health/ready`)) === 200) {
          if ((await status(`${base}/`, { accept: 'text/html' })) !== 200)
            throw new Error('the new version is ready but does not serve the web app');
          return;
        }
        await Promise.race([sleep(500, undefined, { ref: false }), aborted]);
      }
      throw new Error(`the new version was not ready within ${timeoutMs / 1000} s; see ${logFile}`);
    } finally {
      if (!exited) {
        child.kill('SIGTERM');
        // Unreferenced: the grace timer must not keep the process alive after the child exited.
        await Promise.race([exit, sleep(15_000, undefined, { ref: false })]);
        if (!exited) {
          child.kill('SIGKILL');
          await exit;
        }
      }
      child.stdin.destroy();
      await output.close();
    }
  };
}
