// Real migration and readiness for the CLI: boot the version's start.mjs against a state folder
// on a free loopback port, wait for /health/ready and the web shell, then stop it. The API
// applies forward migrations at boot, so the first boot is the migration. Tests never use this.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, readFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer } from 'node:net';
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

/** Returns `({ versionDir, stateDir }) => Promise<void>` that boots, checks and stops. */
export function bootCheck({ logFile, timeoutMs = 120_000 }) {
  return async ({ versionDir, stateDir }) => {
    const port = await freePort();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('SIPGES_')),
    );
    Object.assign(env, {
      SIPGES_DATA_KEY: await secret(stateDir, 'data-key'),
      SIPGES_ADMIN_PASSWORD: await secret(stateDir, 'admin-password'),
      SIPGES_COOKIE_SECURE: '0',
      SIPGES_HOST: '127.0.0.1',
      SIPGES_PORT: String(port),
      SIPGES_PGLITE_DIR: join(stateDir, 'pglite'),
      SIPGES_UPLOAD_DIR: join(stateDir, 'uploads'),
      SIPGES_WEB_DIR: join(versionDir, 'web'),
    });
    const output = await open(logFile, 'a', 0o600);
    const child = spawn(process.execPath, [join(versionDir, 'start.mjs')], {
      cwd: versionDir,
      env,
      stdio: ['ignore', output.fd, output.fd],
      windowsHide: true,
    });
    let exited = null;
    child.on('exit', (code, signal) => (exited = { code, signal }));
    try {
      const deadline = Date.now() + timeoutMs;
      const base = `http://127.0.0.1:${port}`;
      while (Date.now() < deadline) {
        if (exited)
          throw new Error(
            `the new version stopped while starting (code ${exited.code}); see ${logFile}`,
          );
        if ((await status(`${base}/health/ready`)) === 200) {
          if ((await status(`${base}/`, { accept: 'text/html' })) !== 200)
            throw new Error('the new version is ready but does not serve the web app');
          return;
        }
        await sleep(500);
      }
      throw new Error(`the new version was not ready within ${timeoutMs / 1000} s; see ${logFile}`);
    } finally {
      if (!exited) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), sleep(15_000)]);
        if (!exited) child.kill('SIGKILL');
      }
      await output.close();
    }
  };
}
