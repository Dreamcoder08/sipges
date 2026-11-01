import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const apiMain = path.join(repoRoot, 'apps/api/src/main.ts');
export const webDist = path.join(repoRoot, 'apps/web/dist');
export const workerDir = path.join(repoRoot, 'apps/hosting-cloudflare');

/** A free loopback port chosen by the OS (closed again before the API binds it). */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('port')),
      );
    });
  });

/** Synthetic secrets generated per run; they never leave the temporary directory or env. */
export const syntheticSecrets = () => ({
  adminPassword: `e2e-${randomBytes(18).toString('base64url')}`,
  dataKey: randomBytes(32).toString('base64'),
});

export type RunningApi = {
  readonly url: string;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
};

export type StartOptions = {
  /** Extra or overriding SIPGES_* variables; `undefined` removes a variable. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Host name used in the returned URL (the API always binds 127.0.0.1). */
  readonly hostname?: string;
  readonly timeoutMs?: number;
};

const baseEnv = (): Record<string, string> => {
  // Only what Node needs to run; no SIPGES_* variable of the caller leaks into the API.
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT'];
  return Object.fromEntries(
    keep.flatMap((key) => (process.env[key] ? [[key, process.env[key] ?? '']] : [])),
  );
};

/** Process environment for the API; an `undefined` value leaves that variable unset. */
const mergeEnv = (overrides: Readonly<Record<string, string | undefined>>) => {
  const env: Record<string, string> = baseEnv();
  const set = Object.entries(overrides).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return { ...env, ...Object.fromEntries(set) };
};

/** Spawns the real API composition root (apps/api/src/main.ts) and waits for /health. */
export const startApi = async (options: StartOptions): Promise<RunningApi> => {
  const port = await freePort();
  const env = mergeEnv({ SIPGES_HOST: '127.0.0.1', ...options.env, SIPGES_PORT: String(port) });
  let output = '';
  const child: ChildProcess = spawn(process.execPath, [apiMain], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const url = `http://${options.hostname ?? '127.0.0.1'}:${port}`;
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  };

  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API exited with code ${child.exitCode} before it was ready:\n${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { url, output: () => output, stop };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stop();
  throw new Error(`API did not become healthy in time:\n${output}`);
};

/**
 * Runs the Cloudflare Workers adapter under `wrangler dev` (workerd) against a PostgreSQL
 * database through Hyperdrive's local connection, with R2 simulated in `stateDir`. Secrets go
 * to a 0600 `.dev.vars` file there, never to the command line.
 */
export const startWorker = async (options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly databaseUrl: string;
  readonly stateDir: string;
  readonly hostname?: string;
  readonly timeoutMs?: number;
}): Promise<RunningApi> => {
  const port = await freePort();
  const vars = path.join(options.stateDir, '.dev.vars');
  const lines = Object.entries(options.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  await writeFile(vars, `${lines.join('\n')}\n`, { mode: 0o600 });
  const wrangler = path.join(workerDir, 'node_modules/.bin/wrangler');
  const args = ['dev', '--port', String(port), '--ip', '127.0.0.1'];
  args.push('--persist-to', path.join(options.stateDir, 'state'), '--env-file', vars);
  const child: ChildProcess = spawn(wrangler, args, {
    cwd: workerDir,
    env: {
      ...baseEnv(),
      WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: options.databaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const url = `http://${options.hostname ?? '127.0.0.1'}:${port}`;
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timer);
  };
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited with code ${child.exitCode}:\n${output}`);
    }
    try {
      // The host allowlist sees the public name, so probe the same URL the browser uses.
      const response = await fetch(`${url}/health`);
      if (response.ok) return { url, output: () => output, stop };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await stop();
  throw new Error(`The Worker did not become healthy in time:\n${output}`);
};

/** Runs the API expecting it to refuse to start; resolves with its exit code and output. */
export const expectStartupFailure = async (
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ code: number | null; output: string }> => {
  const merged = mergeEnv({ ...env, SIPGES_PORT: String(await freePort()) });
  const child = spawn(process.execPath, [apiMain], { cwd: repoRoot, env: merged });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  clearTimeout(timer);
  return { code, output };
};

/** A temporary directory for PGlite and uploads, removed by the returned cleanup. */
export const scratchDir = async (label: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), `sipges-e2e-${label}-`));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
};

export const assertWebBuilt = () => {
  if (!existsSync(path.join(webDist, 'index.html'))) {
    throw new Error('apps/web/dist is missing: run `pnpm --filter @sipges/web build` first.');
  }
};

export const assertWorkerBuilt = () => {
  if (!existsSync(path.join(workerDir, 'public', 'index.html'))) {
    throw new Error(
      'apps/hosting-cloudflare/public is missing: run `pnpm --filter @sipges/hosting-cloudflare build` first.',
    );
  }
};
