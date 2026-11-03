/**
 * Parity runner (docs/adr/0032 §6): sends every case of cases.ts to the TypeScript API and to
 * the Go API, which share one synthetic database, and fails on any difference in status, media
 * type or JSON.
 *
 *   SIPGES_PARITY_DATABASE_URL=postgres://…/postgres pnpm parity
 *     creates sipges_parity_<random> there, starts both APIs on it, drops it at the end.
 *   SIPGES_PARITY_TS_URL=… SIPGES_PARITY_GO_URL=… pnpm parity
 *     targets two running APIs; cases with `auth` also need SIPGES_PARITY_ADMIN_USERNAME and
 *     SIPGES_PARITY_ADMIN_PASSWORD of a synthetic administrator.
 */
import { CASES, type ParityCase, validateCases } from './cases.ts';
import { type Body, type Mismatch, type Observed, compare } from './diff.ts';
import {
  type Running,
  scratchDatabase,
  signIn,
  startGoApi,
  startTypeScriptApi,
  syntheticSecrets,
} from './servers.ts';

type Targets = {
  tsUrl: string;
  goUrl: string;
  credentials?: { username: string; password: string };
};

const send = async (
  baseUrl: string,
  c: ParityCase,
  cookie: string | undefined,
): Promise<Observed> => {
  const headers = new Headers(c.headers);
  if (c.auth && cookie) headers.set('cookie', cookie);
  let body: string | null = null;
  if (c.body && 'json' in c.body) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(c.body.json);
  } else if (c.body) {
    headers.set('content-type', 'application/x-www-form-urlencoded');
    body = new URLSearchParams(c.body.form).toString();
  }
  const response = await fetch(`${baseUrl}${c.path}`, {
    method: c.method,
    headers,
    body,
    redirect: 'manual',
  });
  const contentType = response.headers.get('content-type') ?? undefined;
  const text = await response.text();
  let parsed: Body = { kind: 'text', value: text };
  if (contentType?.toLowerCase().includes('json')) {
    try {
      parsed = { kind: 'json', value: JSON.parse(text) };
    } catch {
      // A JSON media type with an invalid body compares as text, so the difference shows.
    }
  }
  return { status: response.status, contentType, body: parsed };
};

const describe = (m: Mismatch) =>
  m.field === 'body'
    ? `  body ${m.path}: ts=${JSON.stringify(m.ts)} go=${JSON.stringify(m.go)}`
    : `  ${m.field}: ts=${JSON.stringify(m.ts)} go=${JSON.stringify(m.go)}`;

const runCases = async ({ tsUrl, goUrl, credentials }: Targets) => {
  let cookie: string | undefined;
  if (CASES.some((c) => c.auth)) {
    if (!credentials) throw new Error('cases with auth need SIPGES_PARITY_ADMIN_USERNAME/PASSWORD');
    cookie = await signIn(tsUrl, credentials.username, credentials.password);
  }
  let failed = 0;
  for (const c of CASES) {
    const [ts, go] = await Promise.all([send(tsUrl, c, cookie), send(goUrl, c, cookie)]);
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
    const { SIPGES_PARITY_ADMIN_USERNAME: username, SIPGES_PARITY_ADMIN_PASSWORD: password } =
      process.env;
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
  const running: Running[] = [];
  try {
    // TypeScript first: it applies the migrations the Go API expects.
    const ts = await startTypeScriptApi(database.url, secrets);
    running.push(ts);
    const go = await startGoApi(database.url);
    running.push(go);
    return await runCases({
      tsUrl: ts.url,
      goUrl: go.url,
      credentials: { username: secrets.adminUsername, password: secrets.adminPassword },
    });
  } finally {
    await Promise.allSettled(running.map((api) => api.stop()));
    await database.drop();
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
