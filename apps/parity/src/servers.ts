import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export type Running = { readonly url: string; readonly stop: () => Promise<void> };

/** Synthetic credentials generated per run; they live only in this process and its children. */
export const syntheticSecrets = () => ({
  adminUsername: 'parity-admin',
  adminPassword: `parity-${randomBytes(18).toString('base64url')}`,
  dataKey: randomBytes(32).toString('base64'),
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no free port')),
      );
    });
  });

/** Only what the toolchains need; no SIPGES_* variable of the caller leaks into either API. */
const baseEnv = () =>
  Object.fromEntries(
    [
      'PATH',
      'HOME',
      'TMPDIR',
      'LANG',
      'GOPATH',
      'GOCACHE',
      'GOMODCACHE',
      'GOFLAGS',
      'GOTOOLCHAIN',
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key] ?? '']] : [])),
  );

/** A throwaway database on the server named by `serverUrl`; `drop` removes it with its sessions. */
export const scratchDatabase = async (serverUrl: string) => {
  const name = `sipges_parity_${randomBytes(6).toString('hex')}`;
  const admin = postgres(serverUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
};

/** Last part of a child's output kept for error messages; older text is dropped. */
const OUTPUT_LIMIT = 64 * 1024;

/**
 * Spawns `command` and waits until GET /health answers. Rejects at once when the process
 * cannot start, exits (with a code or a signal) before it is ready, or misses the deadline.
 */
export const startProcess = async (
  label: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  port: number,
): Promise<Running> => {
  let output = '';
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
  };
  const child: ChildProcess = spawn(command, args, {
    cwd: repoRoot,
    env: { ...baseEnv(), ...env, SIPGES_HOST: '127.0.0.1', SIPGES_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  // 'close' follows 'exit', and also follows 'error' when the process never started.
  let ended: string | undefined;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.once('error', (error) => {
    ended = `could not start (${error.message})`;
  });
  child.once('exit', (code, signal) => {
    ended = signal ? `exited with signal ${signal}` : `exited with code ${code}`;
  });
  const stop = async () => {
    if (ended === undefined) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await closed;
    clearTimeout(timer);
  };
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (ended !== undefined) {
      await closed;
      throw new Error(`${label} ${ended} before it was ready:\n${output}`);
    }
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })).ok) {
        return { url, stop };
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stop();
  throw new Error(`${label} did not become healthy in time:\n${output}`);
};

/** The real TypeScript composition root; it applies the migrations and seeds the administrator. */
export const startTypeScriptApi = async (
  databaseUrl: string,
  secrets: ReturnType<typeof syntheticSecrets>,
) =>
  startProcess(
    'TypeScript API',
    process.execPath,
    [path.join(repoRoot, 'apps/api/src/main.ts')],
    {
      SIPGES_DATABASE_URL: databaseUrl,
      SIPGES_DATA_KEY: secrets.dataKey,
      SIPGES_ADMIN_USERNAME: secrets.adminUsername,
      SIPGES_ADMIN_PASSWORD: secrets.adminPassword,
      // MFA enrolment has its own tests; the parity session must reach the routes themselves.
      SIPGES_REQUIRE_MFA: '0',
      SIPGES_ACCESS_LOG: '0',
      SIPGES_AUTOMATION_INTERVAL: '0',
      // No embedding server: features that would call one fall back to rules.
      SIPGES_OLLAMA_URL: 'http://127.0.0.1:9',
    },
    await freePort(),
  );

/** Builds apps/api-go into `dir` (removed by the caller) and runs it against the same database. */
export const startGoApi = async (databaseUrl: string, dir: string): Promise<Running> => {
  const binary = path.join(dir, 'api-go');
  await promisify(execFile)('go', ['build', '-o', binary, './cmd/api'], {
    cwd: path.join(repoRoot, 'apps/api-go'),
    env: baseEnv(),
  });
  return startProcess(
    'Go API',
    binary,
    [],
    { SIPGES_DATABASE_URL: databaseUrl, SIPGES_ACCESS_LOG: '0' },
    await freePort(),
  );
};

/**
 * Signs the synthetic administrator in through the TypeScript API and returns the Cookie header
 * value of the session it set (the same session row serves both APIs).
 */
export const signIn = async (tsUrl: string, username: string, password: string) => {
  const response = await fetch(`${tsUrl}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: tsUrl },
    body: new URLSearchParams({ username, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed with status ${response.status}`);
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';')[0] ?? '');
  if (cookies.length === 0) throw new Error('sign-in set no cookie');
  return cookies.join('; ');
};
