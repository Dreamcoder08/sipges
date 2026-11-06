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
import { assistedBriefingCases, setExternalAi, unpairedNarrations } from './assisted-briefing.ts';
import { CASES, validateCases } from './cases.ts';
import { startEmbedderDouble } from './embedder-double.ts';
import { compareIndexes, semanticSearchCases } from './semantic-search.ts';
import { type Mismatch, checkText, compare } from './diff.ts';
import { nodeVersionProblem } from './node-version.ts';
import { seedDatabase } from './fixtures.ts';
import { REQUEST_TIMEOUT_MS, send } from './request.ts';
import { type Sessions, seed } from './seed.ts';
import type { ParityCase } from './types.ts';
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

const compareCases = async (
  { tsUrl, goUrl }: Targets,
  cases: readonly ParityCase[],
  sessions: Sessions | undefined,
) => {
  let failed = 0;
  for (const c of cases) {
    const [ts, go] = await Promise.all([
      send(tsUrl, c, c.auth && sessions?.[c.auth], REQUEST_TIMEOUT_MS, 'ts'),
      send(goUrl, c, c.auth && sessions?.[c.auth], REQUEST_TIMEOUT_MS, 'go'),
    ]);
    const mismatches = compare(ts, go, c.normalize);
    const promises = [
      ...checkText(ts.body, c.present, c.absent).map((m) => `  ts: ${m}`),
      ...checkText(go.body, c.present, c.absent).map((m) => `  go: ${m}`),
    ];
    if (mismatches.length === 0 && promises.length === 0) {
      console.info(`ok    ${c.method} ${c.path} — ${c.name} (${ts.status})`);
      continue;
    }
    failed++;
    console.info(`FAIL  ${c.method} ${c.path} — ${c.name}`);
    for (const m of mismatches) console.info(describe(m));
    for (const m of promises) console.info(m);
  }
  console.info(`\n${cases.length - failed}/${cases.length} cases match`);
  return failed === 0;
};

const runCases = async (targets: Targets) => {
  const { tsUrl, credentials } = targets;
  let sessions: Sessions | undefined;
  if (CASES.some((c) => c.auth)) {
    if (!credentials) throw new Error('cases with auth need SIPGES_PARITY_ADMIN_USERNAME/PASSWORD');
    sessions = await seed(tsUrl, credentials);
  }
  return { passed: await compareCases(targets, CASES, sessions), sessions };
};

const main = async () => {
  const problem = nodeVersionProblem(process.version, process.env.SIPGES_PARITY_ANY_NODE === '1');
  if (problem) throw new Error(problem);
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
    const { passed } = await runCases({
      tsUrl,
      goUrl,
      ...(username && password ? { credentials: { username, password } } : {}),
    });
    return passed;
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
    const embedder = await startEmbedderDouble();
    running.push(embedder);
    const ts = await startTypeScriptApi(database.url, secrets, embedder.url);
    running.push(ts);
    await database.migrated();
    await seedDatabase(database.adminUrl);
    const go = await startGoApi(database.url, scratch, secrets.dataKey, embedder.url);
    running.push(go);
    const { passed, sessions } = await runCases({
      tsUrl: ts.url,
      goUrl: go.url,
      credentials: { username: secrets.adminUsername, password: secrets.adminPassword },
    });
    if (!sessions) throw new Error('the cases seeded no sessions');

    // Hybrid search needs both APIs restarted with it on; see semantic-search.ts.
    await Promise.all(running.splice(1).map((api) => api.stop()));
    const hybridTs = await startTypeScriptApi(database.url, secrets, embedder.url, true);
    running.push(hybridTs);
    const hybridGo = await startGoApi(database.url, scratch, secrets.dataKey, embedder.url, true);
    running.push(hybridGo);
    const indexes = await compareIndexes(database.adminUrl, sessions.admin, {
      ts: hybridTs.url,
      go: hybridGo.url,
    });
    console.info(
      `${indexes.same ? 'ok  ' : 'FAIL'}  semantic index: ts=${JSON.stringify(indexes.ts)} go=${JSON.stringify(indexes.go)}`,
    );
    const hybrid = await compareCases(
      { tsUrl: hybridTs.url, goUrl: hybridGo.url },
      semanticSearchCases,
      sessions,
    );

    const urls = { tsUrl: hybridTs.url, goUrl: hybridGo.url };
    // Earlier cases may have left the switch on.
    await setExternalAi(hybridTs.url, sessions.admin, false);
    const off = await compareCases(urls, assistedBriefingCases('switch off'), sessions);
    const leaked = embedder.narrated.length;
    await setExternalAi(hybridTs.url, sessions.admin, true);
    const on = await compareCases(urls, assistedBriefingCases('switch on'), sessions);
    const unpaired = unpairedNarrations(embedder.narrated);
    const narrated = leaked === 0 && embedder.narrated.length > 0 && unpaired === 0;
    console.info(
      `${narrated ? 'ok  ' : 'FAIL'}  narrated briefings: ${leaked} with the switch off, ${embedder.narrated.length} with it on, ${unpaired} unpaired`,
    );
    return passed && indexes.same && hybrid && off && on && narrated;
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
