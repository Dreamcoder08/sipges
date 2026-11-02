/**
 * Concurrency stress against a real PostgreSQL behind an artificial network delay.
 *
 * Production pays a Lima ↔ us-east-1 round trip on every database message, which the
 * in-process PGlite benchmarks cannot show. This runner puts a TCP proxy that delays every
 * chunk by half the configured round trip between the API and a synthetic PostgreSQL server,
 * caps the shared pool (5 by default, like one Worker request), and fires the requests a screen fires,
 * at increasing concurrency.
 *
 *   SIPGES_STRESS_DATABASE_URL=postgres://user@127.0.0.1:5432/postgres \
 *     node bench/latency-stress.ts [--rtt 130] [--levels 1,8,32] [--rounds 3] [--pool 5]
 *
 * The URL must point to a disposable synthetic server: a scratch database is created there,
 * filled with synthetic records and dropped at the end. Output is one JSON document.
 */
import { randomBytes } from 'node:crypto';
import { createServer, connect, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import type { EmbeddingProvider } from '../src/contexts/intelligence/application/index.ts';
import { loadMigrations, migrate } from '../src/platform/database/migrator.ts';
import { postgresClient } from '../src/platform/database/postgres.ts';
import { createBenchmarkSession } from './http-session.ts';
import { syntheticRecords } from './synthetic.ts';

const { values } = parseArgs({
  options: {
    rtt: { type: 'string', default: '130' },
    levels: { type: 'string', default: '1,8,32' },
    rounds: { type: 'string', default: '3' },
    scale: { type: 'string', default: '1' },
    // Connections shared by all requests: 5 is one Worker request's client, 20 Hyperdrive's origin limit.
    pool: { type: 'string', default: '5' },
  },
});
const rttMs = Number(values.rtt);
const levels = values.levels.split(',').map(Number);
const rounds = Number(values.rounds);
const poolSize = Number(values.pool);
const adminUrl = process.env['SIPGES_STRESS_DATABASE_URL'];
if (!adminUrl) throw new Error('SIPGES_STRESS_DATABASE_URL must name a synthetic server');

/** The requests the shell and the home screen fire together on load. */
const SCREEN = [
  '/system/auth/me',
  '/system/v4/settings',
  '/system/notifications',
  '/api/registros/summary?limit=500&offset=0',
  '/api/dashboard',
  '/system/irsa',
] as const;

/** Delays every chunk in both directions by half the round trip, preserving order. */
const delayProxy = (target: URL, oneWayMs: number) =>
  new Promise<{ port: number; close: () => void }>((resolve) => {
    const sockets = new Set<Socket>();
    const pipe = (from: Socket, to: Socket) => {
      let last = 0;
      from.on('data', (chunk) => {
        const due = Math.max(performance.now() + oneWayMs, last);
        last = due;
        setTimeout(() => to.destroyed || to.write(chunk), due - performance.now());
      });
      from.on('close', () => setTimeout(() => to.destroy(), oneWayMs));
      from.on('error', () => to.destroy());
    };
    const server = createServer((client) => {
      const upstream = connect(Number(target.port || 5432), target.hostname);
      sockets.add(client).add(upstream);
      pipe(client, upstream);
      pipe(upstream, client);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });

const offline: EmbeddingProvider = {
  model: 'offline-stress',
  egress: 'local',
  embed: () => Promise.reject(new Error('offline')),
};

const percentile = (sorted: readonly number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

const name = `sipges_stress_${randomBytes(6).toString('hex')}`;
const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
await admin.unsafe(`CREATE DATABASE ${name}`);
const direct = new URL(adminUrl);
direct.pathname = `/${name}`;
const owner = postgresClient(direct.toString(), { max: 2 });
const proxy = await delayProxy(direct, rttMs / 2);
const delayed = new URL(direct);
delayed.hostname = '127.0.0.1';
delayed.port = String(proxy.port);
const pool = postgresClient(delayed.toString(), { max: poolSize });
// postgres.js prints server notices (migrations raise a few) with console.log; keep stdout JSON.
const print = console.log;
console.log = () => undefined;
try {
  await migrate(owner.client, await loadMigrations());
  // The session bootstraps the tenant that the synthetic records belong to.
  const session = await createBenchmarkSession(pool.client, offline);
  const tenant = 'SIPGES/PRJ-SECHURA';
  const records = syntheticRecords(Number(values.scale));
  for (const [module, rows] of Object.entries(records))
    for (let i = 0; i < rows.length; i += 500)
      await owner.client.query(
        `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
         SELECT $1, $2, x.id, x.payload, now(), now()
           FROM jsonb_to_recordset($3::text::jsonb) AS x(id text, payload jsonb)`,
        [
          tenant,
          module,
          JSON.stringify(
            rows.slice(i, i + 500).map((payload, j) => ({ id: `${module}-${i + j}`, payload })),
          ),
        ],
      );
  const timed = async (path: string) => {
    const started = performance.now();
    try {
      await session.get(path);
      return { path, ms: performance.now() - started, ok: true };
    } catch {
      return { path, ms: performance.now() - started, ok: false };
    }
  };
  // Warm up the pool and the per-isolate caches the way a first screen would.
  await Promise.all(SCREEN.map(timed));
  const results = [];
  for (const concurrency of levels) {
    const samples: { path: string; ms: number; ok: boolean }[] = [];
    const started = performance.now();
    for (let round = 0; round < rounds; round++)
      // `concurrency` screens in flight at once, each firing its whole request set together.
      samples.push(
        ...(
          await Promise.all(
            Array.from({ length: concurrency }, () => Promise.all(SCREEN.map(timed))),
          )
        ).flat(),
      );
    const wallMs = performance.now() - started;
    const byPath = Object.fromEntries(
      SCREEN.map((path) => {
        const ms = samples
          .filter((s) => s.path === path && s.ok)
          .map((s) => s.ms)
          .sort((a, b) => a - b);
        return [
          path,
          {
            p50: Math.round(percentile(ms, 50)),
            p95: Math.round(percentile(ms, 95)),
            max: Math.round(ms.at(-1) ?? NaN),
            errors: samples.filter((s) => s.path === path && !s.ok).length,
          },
        ];
      }),
    );
    results.push({
      concurrency,
      requests: samples.length,
      wallMs: Math.round(wallMs),
      throughputPerS: Math.round((samples.length / wallMs) * 1000 * 10) / 10,
      byPath,
    });
  }
  print(JSON.stringify({ rttMs, pool: poolSize, rounds, levels: results }, null, 2));
} finally {
  await pool.close();
  await owner.close();
  proxy.close();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}
