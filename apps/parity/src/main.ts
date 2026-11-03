/**
 * Parity runner (docs/adr/0032 §6): sends every case of cases.ts to the TypeScript API and to
 * the Go API, which share one synthetic database, and fails on any difference in status, media
 * type or JSON.
 *
 *   SIPGES_PARITY_DATABASE_URL=postgres://…/postgres pnpm parity
 *     creates sipges_parity_<random> there, starts both APIs on it, drops it at the end.
 *   SIPGES_PARITY_TS_URL=… SIPGES_PARITY_GO_URL=… pnpm parity
 *     targets two running APIs on a fresh synthetic database; SIPGES_PARITY_ADMIN_USERNAME and
 *     SIPGES_PARITY_ADMIN_PASSWORD name its administrator, and the runner seeds the users of
 *     seed.ts through the TypeScript API.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CASES, validateCases } from './cases.ts';
import { type Mismatch, compare } from './diff.ts';
import { seedDatabase } from './fixtures.ts';
import { REQUEST_TIMEOUT_MS, send } from './request.ts';
import { type Sessions, seed } from './seed.ts';
import {
  type Running,
  scratchDatabase,
  startGoApi,
  startTypeScriptApi,
  syntheticSecrets,
} from './servers.ts';

type Targets = {
  tsUrl: string;
  goUrl: string;
  credentials?: { username: string; password: string };
};

const describe = (m: Mismatch) =>
  m.field === 'body'
    ? `  body ${m.path}: ts=${JSON.stringify(m.ts)} go=${JSON.stringify(m.go)}`
    : `  ${m.field}: ts=${JSON.stringify(m.ts)} go=${JSON.stringify(m.go)}`;

const runCases = async ({ tsUrl, goUrl, credentials }: Targets) => {
  let sessions: Sessions | undefined;
  if (CASES.some((c) => c.auth)) {
    if (!credentials) throw new Error('cases with auth need SIPGES_PARITY_ADMIN_USERNAME/PASSWORD');
    sessions = await seed(tsUrl, credentials);
  }
  let failed = 0;
  for (const c of CASES) {
    const [ts, go] = await Promise.all([
      send(tsUrl, c, c.auth && sessions?.[c.auth], REQUEST_TIMEOUT_MS),
      send(goUrl, c, c.auth && sessions?.[c.auth], REQUEST_TIMEOUT_MS),
    ]);
    const mismatches = compare(ts, go, c.normalize);
    if (mismatches.length === 0) {
      console.info(`ok    ${c.method} ${c.path} — ${c.name} (${ts.status})`);
      continue;
    }
    failed++;
    console.info(`FAIL  ${c.method} ${c.path} — ${c.name}`);
    for (const m of mismatches) console.info(describe(m));
  }
  console.info(`\n${CASES.length - failed}/${CASES.length} cases match`);
  return failed === 0;
};

const main = async () => {
  const errors = validateCases(CASES);
  if (errors.length > 0) throw new Error(`invalid route list:\n${errors.join('\n')}`);

  const { SIPGES_PARITY_TS_URL: tsUrl, SIPGES_PARITY_GO_URL: goUrl } = process.env;
  if (tsUrl && goUrl) {
    const {
      SIPGES_PARITY_ADMIN_USERNAME: username,
      SIPGES_PARITY_ADMIN_PASSWORD: password,
      SIPGES_PARITY_SEED_DATABASE_URL: seedUrl,
    } = process.env;
    // The rows of fixtures.ts load only when asked for, into the database both APIs share.
    if (seedUrl) await seedDatabase(seedUrl);
    return runCases({
      tsUrl,
      goUrl,
      ...(username && password ? { credentials: { username, password } } : {}),
    });
  }
  const serverUrl = process.env.SIPGES_PARITY_DATABASE_URL;
  if (!serverUrl) {
    throw new Error(
      'set SIPGES_PARITY_DATABASE_URL (a synthetic PostgreSQL server) or both SIPGES_PARITY_TS_URL and SIPGES_PARITY_GO_URL',
    );
  }
  const secrets = syntheticSecrets();
  const database = await scratchDatabase(serverUrl);
  const scratch = await mkdtemp(path.join(tmpdir(), 'sipges-parity-'));
  const running: Running[] = [];
  // Runs once: a signal during the run and the finally below share the same cleanup.
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      await Promise.allSettled(running.map((api) => api.stop()));
      await rm(scratch, { recursive: true, force: true });
      await database.drop();
    })());

  // Ctrl-C or a cancelled CI job still stops both APIs and drops the scratch database.
  const interrupted = (signal: NodeJS.Signals) => {
    console.error(`parity: ${signal}, cleaning up`);
    void cleanup().finally(() => process.exit(130));
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    // TypeScript first: it applies the migrations the Go API expects.
    const ts = await startTypeScriptApi(database.url, secrets);
    running.push(ts);
    await seedDatabase(database.url);
    const go = await startGoApi(database.url, scratch);
    running.push(go);
    return await runCases({
      tsUrl: ts.url,
      goUrl: go.url,
      credentials: { username: secrets.adminUsername, password: secrets.adminPassword },
    });
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    await cleanup();
  }
};

main().then(
  (ok) => {
    process.exitCode = ok ? 0 : 1;
  },
  (error: unknown) => {
    console.error('parity:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
