// Desktop stack benchmark (go-rust-stack T72): the stack the laptop runs today, the TypeScript API
// on PGlite (apps/api/src/main.ts with SIPGES_PGLITE_DIR, as the desktop launcher starts it),
// against the one it moves to, the Go launcher (sipges-desktop) with the Go API and PostgreSQL 18,
// on the same synthetic data. Synthetic data only; no repository dataset is read.
//
//   node deploy/desktop/bench/desktop-bench.mjs [--sizes 1,10] [--reps 3] [--steps 1,4,8]
//     [--step-seconds 10] [--writes 40] [--stacks ts,go] [--pg-bin <dir>] [--bin-dir <dir>]
//     [--work <new dir>] [--logs <dir>] [--out result.json] [--label name]
//
// For every size (1× is the legacy installation's record counts, bench/synthetic.ts):
// 1. Prepare one state folder per stack: the first start applies the migrations and creates the
//    administrator; then the same synthetic records go into module_records with the same SQL
//    (PGlite opened in this process with the API stopped; PostgreSQL through the running launcher
//    as its superuser), followed by ANALYZE and CHECKPOINT.
// 2. Repetitions alternate which stack runs first. Each run copies the prepared folder, so every
//    run starts from the same data, and measures: start to GET /health/ready answering 200; the
//    screens of bench:prod-screens (prod-screens.ts SCREENS) at each step of concurrent screens;
//    sequential record creates and updates (POST and PUT /api/eventos); the peak memory of the
//    API and database processes; and the data folder's size after the run.
// Results: JSON (--out or stdout) and a Markdown summary on stderr. Every repetition is kept;
// outliers are flagged, never dropped. Server logs go to --logs (default: <work>/logs). When a run
// fails, the runs that finished are written (to --out, or <logs>/partial-result.json), the work
// folder is kept and its path printed, and the exit code is 1.
/* global fetch, setTimeout, clearTimeout, AbortSignal, URLSearchParams, Buffer */
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import console from 'node:console';
import { freePort } from '../updater/boot.mjs';
import {
  aggregate,
  bestEffort,
  classify,
  describeFailure,
  folderBytes,
  insertBatches,
  keepWorkFolder,
  killOrder,
  memoryMetricRows,
  memoryMetrics,
  parseOptions,
  progressLine,
  parseProcStatus,
  parseSmapsRollup,
  renderMarkdown,
  resolvePgBin,
  runOrder,
  summarizeSamples,
  timedRequest,
} from './desktop-bench-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const API_DIR = join(repo, 'apps/api');
const MIGRATIONS = join(API_DIR, 'src/platform/database/migrations');
const TENANT = 'SIPGES/PRJ-SECHURA';
const READY_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 45_000;
const WRITE_TIMEOUT_MS = 45_000;
const SAMPLE_MS = 500;
const isWindows = platform() === 'win32';
const exe = (name) => (isWindows ? `${name}.exe` : name);
const say = (line) => console.error(line);

const options = parseOptions(process.argv.slice(2));

// prod-screens.ts and synthetic.ts are TypeScript: Node strips their types on import.
const { SCREENS, httpProbe, runSteps, stats } = await import(
  pathToFileURL(join(API_DIR, 'bench/prod-screens.ts')).href
);
const { syntheticRecords, totalRecords } = await import(
  pathToFileURL(join(API_DIR, 'bench/synthetic.ts')).href
);
const requireApi = createRequire(join(API_DIR, 'package.json'));
const load = async (name) => import(pathToFileURL(requireApi.resolve(name)).href);
const { PGlite } = await load('@electric-sql/pglite');
const { default: postgres } = await load('postgres');

// ---- processes ---------------------------------------------------------------------------

const running = new Set();
let interrupted = null;

function startProcess(command, args, { env, log }) {
  const child = spawn(command, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  child.output = '';
  const keep = (chunk) => {
    child.output = (child.output + chunk.toString()).slice(-64 * 1024);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  if (log) {
    child.stdout.on('data', (c) => log.push(c));
    child.stderr.on('data', (c) => log.push(c));
  }
  child.ended = new Promise((done) => {
    child.once('close', (code, signal) => {
      running.delete(child);
      done({ code, signal });
    });
  });
  // A program that cannot start emits no output: its error goes into the failure message.
  child.once('error', (error) => {
    child.output += `could not start ${command}: ${error.message}\n`;
  });
  return child;
}

async function stopProcess(child, graceMs = 60_000) {
  const alive = child.exitCode === null && child.signalCode === null;
  // Windows has no SIGTERM: kill() ends only the launcher, so its whole tree goes; the cluster it
  // leaves is stopped by stopCluster.
  if (alive && isWindows) killTreeWindows(child.pid);
  else if (alive) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  await child.ended;
  clearTimeout(timer);
}

/**
 * Windows: `taskkill /T /F` ends the launcher and everything below it. When taskkill fails, the
 * tree is read from Win32_Process and each process is ended, children first, so the API never
 * outlives the launcher. The cluster it leaves is stopped by stopCluster.
 */
function killTreeWindows(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  } catch {
    say(`taskkill failed for ${pid}; ending its process tree one by one`);
  }
  let procs = [];
  try {
    procs = windowsProcesses();
  } catch {
    // Without the list, only the launcher itself can be ended.
  }
  for (const target of killOrder(procs, pid))
    try {
      process.kill(target);
    } catch {
      // Already gone.
    }
}

/** A postmaster left behind (Windows ends a child without a signal it can handle) is stopped. */
function stopCluster(dataDir) {
  if (!existsSync(join(dataDir, 'postmaster.pid'))) return;
  try {
    execFileSync(join(pgBin, exe('pg_ctl')), ['stop', '-D', dataDir, '-m', 'fast', '-w'], {
      stdio: 'ignore',
    });
  } catch {
    // Already gone between the check and the stop.
  }
}

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (interrupted) for (const child of running) child.kill('SIGKILL');
    interrupted = signal;
    for (const child of running) child.kill('SIGTERM');
  });
const checkInterrupted = () => {
  if (interrupted) throw new Error(`interrupted by ${interrupted}`);
};

async function waitReady(child, base) {
  const started = performance.now();
  while (performance.now() - started < READY_TIMEOUT_MS) {
    checkInterrupted();
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`the server ended before it was ready:\n${child.output}`);
    try {
      const response = await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(2_000) });
      await response.arrayBuffer();
      if (response.status === 200) return performance.now();
    } catch {
      // Not listening yet.
    }
    await sleep(50);
  }
  throw new Error(`the server was not ready in ${READY_TIMEOUT_MS} ms:\n${child.output}`);
}

// ---- memory ------------------------------------------------------------------------------

async function linuxProcesses() {
  const procs = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = parseProcStatus(await readFile(`/proc/${entry}/status`, 'utf8'));
      const cmdline = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).replaceAll('\0', ' ');
      procs.push({ pid: Number(entry), ...status, cmdline });
    } catch {
      // The process ended while it was read.
    }
  }
  return procs;
}

function windowsProcesses() {
  const script =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,PeakWorkingSetSize | ConvertTo-Json -Compress';
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(text).map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    name: p.Name ?? '',
    cmdline: p.CommandLine ?? '',
    rssKb: Math.round(Number(p.WorkingSetSize ?? 0) / 1024),
    hwmKb: Number(p.PeakWorkingSetSize ?? 0),
  }));
}

const pssKb = async (pid) => {
  try {
    return parseSmapsRollup(await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')).pssKb ?? 0;
  } catch {
    return 0;
  }
};

/**
 * Linux: every SAMPLE_MS, the proportional set size (Pss) of each role's processes, summed, so
 * pages shared between PostgreSQL processes count once; plus the API's own peak RSS (VmHWM) read
 * at the end. Windows: one snapshot at the end, peak working set per process (a shared page counts
 * in every process that maps it, so the PostgreSQL sum is an upper bound).
 */
function memoryWatch(rootPid, dataDir, stack) {
  const samples = [];
  let stopped = false;
  const loop = (async () => {
    if (isWindows) return;
    while (!stopped) {
      const roles = classify(await linuxProcesses(), rootPid, dataDir, stack);
      const sum = async (list) => (await Promise.all(list.map((p) => pssKb(p.pid)))).reduce((a, b) => a + b, 0);
      samples.push({ api: await sum(roles.api), database: await sum(roles.database), launcher: await sum(roles.launcher) });
      await sleep(SAMPLE_MS);
    }
  })();
  return async () => {
    const procs = isWindows ? windowsProcesses() : await linuxProcesses();
    const roles = classify(procs, rootPid, dataDir, stack);
    stopped = true;
    await loop;
    const peaks = isWindows ? null : summarizeSamples(samples);
    return {
      source: isWindows
        ? 'peak working set per process, summed per role, one snapshot at the end (Windows)'
        : `VmHWM of the API process; Pss summed per role, sampled every ${SAMPLE_MS} ms (Linux)`,
      samples: samples.length,
      metrics: memoryMetrics({ windows: isWindows, stack, roles, peaks }),
    };
  };
}

// ---- stacks ------------------------------------------------------------------------------

// Only the Go stack needs PostgreSQL's binaries: a TypeScript-only run never looks for them.
const pgBin = resolvePgBin({
  stacks: options.stacks,
  pgBin: options.pgBin,
  env: process.env,
  find: () => execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim(),
});

/** Only what the toolchains need; no SIPGES_* variable of the caller reaches either API. */
const baseEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('SIPGES_')),
  );

const secret = async (state, name) => (await readFile(join(state, name), 'utf8')).trim();

async function newState(dir) {
  await mkdir(join(dir, 'uploads'), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'data-key'), `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  await writeFile(join(dir, 'admin-password'), `${randomBytes(18).toString('base64url')}\n`, { mode: 0o600 });
}

/**
 * The environment each launcher gives its API (boot.mjs managedEnv for TypeScript; the Go
 * launcher sets its own). Both run with MFA off, as apps/parity does, so the run measures the
 * routes and not a second factor; everything else is the desktop default.
 */
const STACK = {
  ts: {
    dataFolder: 'pglite',
    start: async (state, port, log) => {
      const env = {
        ...baseEnv(),
        SIPGES_DATA_KEY: await secret(state, 'data-key'),
        SIPGES_ADMIN_PASSWORD: await secret(state, 'admin-password'),
        SIPGES_COOKIE_SECURE: '0',
        SIPGES_HOST: '127.0.0.1',
        SIPGES_PORT: String(port),
        SIPGES_PGLITE_DIR: join(state, 'pglite'),
        SIPGES_UPLOAD_DIR: join(state, 'uploads'),
        SIPGES_REQUIRE_MFA: '0',
      };
      return startProcess(process.execPath, [join(API_DIR, 'src/main.ts')], { env, log });
    },
  },
  go: {
    dataFolder: 'pg18',
    start: async (state, port, log) =>
      startProcess(
        join(binDir, exe('sipges-desktop')),
        [
          '--state', state,
          '--pg-bin', pgBin,
          '--api', join(binDir, exe('api')),
          '--migrations', MIGRATIONS,
          '--port', String(port),
        ],
        { env: { ...baseEnv(), SIPGES_REQUIRE_MFA: '0' }, log },
      ),
  },
};

const INSERT = `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
  SELECT $1, $2, x.id, x.payload, now(), now()
    FROM jsonb_to_recordset($3::text::jsonb) AS x(id text, payload jsonb)`;

async function seedTs(state, records) {
  const db = new PGlite(join(state, 'pglite'));
  try {
    for (const { module, rows } of insertBatches(records))
      await db.query(INSERT, [TENANT, module, JSON.stringify(rows)]);
    await db.exec('ANALYZE; CHECKPOINT;');
  } finally {
    await db.close();
  }
}

async function seedGo(state, records, launcherOutput) {
  const port = Number(/PostgreSQL started on 127\.0\.0\.1:(\d+)/.exec(launcherOutput)?.[1]);
  if (!port) throw new Error('the Go launcher did not report its PostgreSQL port');
  const sql = postgres({
    host: '127.0.0.1',
    port,
    database: 'sipges',
    username: 'postgres',
    password: await secret(state, 'pg18-superuser-password'),
    max: 1,
    onnotice: () => undefined,
  });
  try {
    for (const { module, rows } of insertBatches(records))
      await sql.unsafe(INSERT, [TENANT, module, JSON.stringify(rows)]);
    await sql.unsafe('ANALYZE');
    await sql.unsafe('CHECKPOINT');
  } finally {
    await sql.end();
  }
}

async function prepare(stack, state, records, tag) {
  await newState(state);
  const port = await freePort();
  const log = [];
  const child = await STACK[stack].start(state, port, log);
  try {
    await waitReady(child, `http://127.0.0.1:${port}`);
    if (stack === 'go') await seedGo(state, records, child.output);
  } finally {
    await stopProcess(child);
    if (stack === 'go') stopCluster(join(state, 'pg18'));
    await bestEffort(
      () => writeFile(join(logsDir, `prepare-${tag}.txt`), Buffer.concat(log)),
      (error) => say(`could not write the prepare log of ${tag}: ${error.message}`),
    );
  }
  if (stack === 'ts') await seedTs(state, records);
  const data = join(state, STACK[stack].dataFolder);
  return { bytes: await folderBytes(data), walBytes: stack === 'go' ? await folderBytes(join(data, 'pg_wal')) : null };
}

// ---- one measured run --------------------------------------------------------------------

async function signIn(base, state) {
  const response = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: await secret(state, 'admin-password'), otp: '' }),
  });
  await response.arrayBuffer();
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c) => c.startsWith('sipges_session='))
    .at(-1);
  if (response.status !== 200 || !cookie) throw new Error(`sign-in answered ${response.status}`);
  return cookie;
}

async function screens(base, cookie) {
  const out = {};
  for (const step of options.steps) {
    checkInterrupted();
    const samples = [];
    const probe = httpProbe(base, cookie, fetch, REQUEST_TIMEOUT_MS, TENANT);
    const run = await runSteps({
      screens: SCREENS,
      steps: [step],
      stepMs: options.stepSeconds * 1000,
      abortErrorRate: 1,
      get: async (path) => {
        const result = await probe(path);
        if (result.status === 200) samples.push(result.ms);
        return result;
      },
      now: () => performance.now(),
    });
    const [result] = run.steps;
    const pooled = stats(samples);
    out[step] = {
      requests: result.requests,
      rps: Math.round(result.requests / options.stepSeconds),
      errorRate: result.errorRate,
      statuses: result.statuses,
      p50: pooled.p50,
      p95: pooled.p95,
      max: pooled.max,
      screen: result.screen,
      path: result.path,
    };
  }
  return out;
}

async function writes(base, cookie, tag) {
  const headers = {
    origin: base,
    cookie,
    accept: 'application/json',
    'content-type': 'application/json',
    'X-SIPGES-Scope': TENANT,
  };
  const timed = (path, method, payload) =>
    timedRequest(fetch, base + path, { method, headers, body: JSON.stringify({ payload }) }, WRITE_TIMEOUT_MS);
  const create = [];
  const update = [];
  let errors = 0;
  const statuses = {};
  for (let i = 0; i < options.writes; i++) {
    const id = `BENCH-${tag}-${String(i).padStart(4, '0')}`;
    const payload = { ID_Evento: id, Titulo: 'Evento sintético de carga', Fecha: '2026-03-01', Participantes: i };
    const made = await timed('/api/eventos', 'POST', payload);
    statuses[made.status] = (statuses[made.status] ?? 0) + 1;
    if (made.ok) create.push(made.ms);
    else errors++;
    const changed = await timed(`/api/eventos/${id}`, 'PUT', { ...payload, Participantes: i + 1 });
    statuses[changed.status] = (statuses[changed.status] ?? 0) + 1;
    if (changed.ok) update.push(changed.ms);
    else errors++;
  }
  const round = (s) => ({ n: s.n, p50: s.p50 && +s.p50.toFixed(1), p95: s.p95 && +s.p95.toFixed(1), max: s.max && +s.max.toFixed(1) });
  return { create: round(stats(create)), update: round(stats(update)), errors, statuses };
}

async function measure(stack, template, work, tag) {
  const state = join(work, `run-${tag}`);
  await cp(template, state, { recursive: true });
  const dataDir = join(state, STACK[stack].dataFolder);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const log = [];
  const started = performance.now();
  const child = await STACK[stack].start(state, port, log);
  const memory = memoryWatch(child.pid, dataDir, stack);
  let result;
  try {
    const ready = await waitReady(child, base);
    const cookie = await signIn(base, state);
    const load = await screens(base, cookie);
    const written = await writes(base, cookie, tag);
    result = { coldStartMs: Math.round(ready - started), screens: load, writes: written, memory: await memory() };
  } finally {
    await stopProcess(child);
    if (stack === 'go') stopCluster(dataDir);
    await bestEffort(
      () => writeFile(join(logsDir, `run-${tag}.txt`), Buffer.concat(log)),
      (error) => say(`could not write the log of ${tag}: ${error.message}`),
    );
  }
  result.dataBytesAfter = await folderBytes(dataDir);
  if (stack === 'go') result.walBytesAfter = await folderBytes(join(dataDir, 'pg_wal'));
  await rm(state, { recursive: true, force: true });
  return result;
}

/** The flat numbers summarized per size and stack; the full run stays in the JSON. */
function flatten(result) {
  const metrics = { coldStartMs: result.coldStartMs };
  for (const [step, s] of Object.entries(result.screens)) {
    metrics[`rps${step}`] = s.rps;
    metrics[`p50_${step}`] = s.p50;
    metrics[`p95_${step}`] = s.p95;
    metrics[`errors${step}`] = s.errorRate;
  }
  metrics.createP50 = result.writes.create.p50;
  metrics.createP95 = result.writes.create.p95;
  metrics.updateP50 = result.writes.update.p50;
  metrics.updateP95 = result.writes.update.p95;
  metrics.writeErrors = result.writes.errors;
  Object.assign(metrics, result.memory.metrics);
  metrics.dataMbAfter = +(result.dataBytesAfter / 2 ** 20).toFixed(1);
  return metrics;
}

const METRICS = [
  { key: 'coldStartMs', label: 'Start to /health/ready (ms)' },
  ...options.steps.flatMap((s) => [
    { key: `rps${s}`, label: `${s} screen(s): requests/s` },
    { key: `p50_${s}`, label: `${s} screen(s): request p50 (ms)` },
    { key: `p95_${s}`, label: `${s} screen(s): request p95 (ms)` },
    { key: `errors${s}`, label: `${s} screen(s): error rate` },
  ]),
  { key: 'createP50', label: 'Create record p50 (ms)' },
  { key: 'createP95', label: 'Create record p95 (ms)' },
  { key: 'updateP50', label: 'Update record p50 (ms)' },
  { key: 'updateP95', label: 'Update record p95 (ms)' },
  { key: 'writeErrors', label: 'Write errors' },
  ...memoryMetricRows(isWindows),
  { key: 'seededMb', label: 'Data folder after seeding (MB)' },
  { key: 'seededWalMb', label: '  of which pg_wal (MB)' },
  { key: 'dataMbAfter', label: 'Data folder after the run (MB)' },
];

// ---- main --------------------------------------------------------------------------------

const version = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const ownWork = !options.work;
const work = options.work ? resolve(options.work) : await mkdtemp(join(tmpdir(), 'sipges-desktop-bench-'));
await mkdir(work, { recursive: true });
// Server logs: --logs, or the work folder. Kept after a failure, with the runs that finished.
const logsDir = options.logs ? resolve(options.logs) : join(work, 'logs');
await mkdir(logsDir, { recursive: true });
let binDir = options.binDir ? resolve(options.binDir) : join(work, 'bin');
if (options.stacks.includes('go') && !options.binDir) {
  say('Building the Go API and launcher…');
  for (const [out, pkg] of [
    ['api', './cmd/api'],
    ['sipges-desktop', './cmd/sipges-desktop'],
  ])
    execFileSync('go', ['build', '-o', join(binDir, exe(out)), pkg], {
      cwd: join(repo, 'apps/api-go'),
      stdio: 'inherit',
    });
}

let failed = null;
const report = {
  label: options.label,
  startedAt: new Date().toISOString(),
  machine: {
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: availableParallelism(),
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    postgres: pgBin ? version(join(pgBin, exe('postgres')), ['--version']) : 'not used',
    go: version('go', ['version']),
  },
  options: { ...options, pgBin: undefined, binDir: undefined, work: undefined, logs: undefined },
  sizes: {},
  runs: [],
};

try {
  for (const size of options.sizes) {
    const records = syntheticRecords(size);
    const templates = {};
    report.sizes[size] = { records: totalRecords(records), seededBytes: {} };
    for (const stack of options.stacks) {
      checkInterrupted();
      say(`Preparing ${stack} at ${size}× (${totalRecords(records)} records)…`);
      templates[stack] = join(work, `template-${stack}-${size}`);
      report.sizes[size].seededBytes[stack] = await prepare(stack, templates[stack], records, `${stack}-${size}x`);
    }
    for (let rep = 0; rep < options.reps; rep++)
      for (const stack of runOrder(rep, options.stacks)) {
        checkInterrupted();
        const tag = `${stack}-${size}x-${rep}`;
        say(`Run ${tag}…`);
        const result = await measure(stack, templates[stack], work, tag);
        const seeded = report.sizes[size].seededBytes[stack];
        const metrics = {
          ...flatten(result),
          seededMb: +(seeded.bytes / 2 ** 20).toFixed(1),
          seededWalMb: seeded.walBytes === null ? null : +(seeded.walBytes / 2 ** 20).toFixed(1),
        };
        report.runs.push({ size, stack, rep, metrics, result });
        say(`  ${progressLine(metrics, options.steps)}`);
      }
    for (const stack of options.stacks) await rm(templates[stack], { recursive: true, force: true });
  }
} catch (error) {
  failed = error;
} finally {
  await Promise.all([...running].map((child) => stopProcess(child, 5_000)));
  if (!keepWorkFolder({ ownWork, failed: Boolean(failed) })) await rm(work, { recursive: true, force: true });
}

if (failed) {
  // What finished is kept: the runs so far go to --out (or the logs folder), never discarded.
  report.failedAt = new Date().toISOString();
  Object.assign(report, describeFailure(failed));
  const partial = options.out ?? join(logsDir, 'partial-result.json');
  await writeFile(partial, `${JSON.stringify(report, null, 2)}\n`);
  say(`\nThe benchmark failed: ${report.stack ?? report.error}`);
  say(`${report.runs.length} finished run(s) in ${partial}; server logs in ${logsDir}`);
  if (ownWork) say(`Work folder kept for inspection: ${work}`);
  process.exit(1);
}

report.finishedAt = new Date().toISOString();
report.aggregate = aggregate(report.runs);
const summary = renderMarkdown(report.aggregate, METRICS);
say(`\n${summary}`);
const json = `${JSON.stringify(report, null, 2)}\n`;
if (options.out) await writeFile(options.out, json);
else process.stdout.write(json);
