// pglite-to-postgres.mjs on synthetic state folders: the refusals (the original folder, a link,
// a non-empty target), the whole move into a throwaway PostgreSQL with no difference, the source
// byte-identical afterwards, no seeded value printed, and the Go API's migrator accepting the
// result as already migrated. The PostgreSQL tests need SIPGES_TEST_DATABASE_URL, a superuser on
// a loopback throwaway server (scripts/agents/test-pg.sh up prints one); without it they skip.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync, watch } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { onSignal, originalState, runMove, strictRules } from './pglite-to-postgres.mjs';
import { treeDigest } from './tables.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const script = join(here, 'pglite-to-postgres.mjs');
const api = join(repo, 'apps/api');
const load = async (name) =>
  import(pathToFileURL(createRequire(join(api, 'package.json')).resolve(name)).href);
const { PGlite } = await load('@electric-sql/pglite');
const { default: postgres } = await load('postgres');
const { loadMigrations, migrate } = await import(
  pathToFileURL(join(api, 'src/platform/database/migrator.ts')).href
);
const { pgliteClient } = await import(
  pathToFileURL(join(api, 'src/platform/database/pglite.ts')).href
);

const S = 'ZZSECRET';
const T = `SIPGES/${S}-ALFA`;
const T2 = `SIPGES/${S}-BETA`;
const D = '2026-01-01T00:00:00Z';
// Records across several modules, a restricted marking, links, audit rows, API keys, history.
const SEED = `
INSERT INTO tenants (company_id, project_id, label) VALUES ('SIPGES', '${S}-ALFA', '${S} Alfa'),
  ('SIPGES', '${S}-BETA', '${S} Beta');
INSERT INTO users (username, full_name, password_hash, role, totp_secret_sealed, totp_enabled,
  totp_last_step, created_at) VALUES
  ('${S}-ana', '${S} Ana', '$scrypt$${S}-hash-ana', 'admin', 'v1.${S}-mfa-ana', true, 7, '${D}'),
  ('${S}-beto', '${S} Beto', '$scrypt$${S}-hash-beto', 'analista', NULL, false, NULL, '${D}');
INSERT INTO grants (username, tenant_id, created_at) VALUES ('${S}-beto', '${T}', '${D}');
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking) VALUES
  ('${T}', 'eventos', '${S}-EV-1', '{"Titulo": "${S} reunión", "n": 1.5}', '${D}', '${D}', 'interno'),
  ('${T}', 'eventos', '${S}-EV-2', '{"Titulo": "${S} reservado"}', '${D}', '${D}', 'restringido'),
  ('${T}', 'actores', '${S}-AC-1', '{"Nombre": "${S} ñandú"}', '${D}', '2026-02-03T04:05:06.789Z', 'publico'),
  ('${T2}', 'conflictos', '${S}-CF-1', '{"Caso": "${S} beta"}', '${D}', '${D}', 'interno');
INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module, target_id,
  note, created_by, created_at) VALUES
  ('${T}', 'involucra', 'eventos', '${S}-EV-1', 'actores', '${S}-AC-1', '${S} nota', '${S}-ana', '${D}'),
  ('${T}', 'relacionado', 'eventos', '${S}-EV-2', 'eventos', '${S}-EV-1', '', '${S}-ana', '${D}');
INSERT INTO record_versions (tenant_id, module, record_id, operation, payload, actor, at, marking)
  VALUES ('${T}', 'eventos', '${S}-EV-1', 'UPDATE', '{"Titulo": "${S} antes"}', '${S}-ana', '${D}', 'interno');
INSERT INTO audit (tenant_id, ts, module, record_id, action, detail) VALUES
  ('${T}', '${D}', 'eventos', '${S}-EV-1', 'create', '${S} uno'),
  ('${T}', '${D}', 'eventos', '${S}-EV-2', 'update', '${S} dos'),
  ('${T2}', '${D}', 'auth', NULL, 'login', '${S}');
INSERT INTO api_keys (tenant_id, name, prefix, secret_hash, access, clearance, created_by, created_at)
  VALUES ('${T}', '${S}-k1', 'a1b2c3d4e5f6', '${S}-keyhash-1', 'read', 'limited', '${S}-ana', '${D}'),
  ('${T}', '${S}-k2', 'f6e5d4c3b2a1', '${S}-keyhash-2', 'write', 'full', '${S}-ana', '${D}');`;

const scratch = await mkdtemp(join(tmpdir(), 'sipges-pglite-move-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A state folder made by the API's own migrator, with synthetic rows across modules. */
async function makeState(dir) {
  await mkdir(join(dir, 'uploads'), { recursive: true });
  const db = new PGlite(join(dir, 'pglite'));
  await migrate(pgliteClient(db), await loadMigrations());
  await db.exec(SEED);
  await db.close();
  await writeFile(join(dir, 'data-key'), `${S}-data-key`);
  await writeFile(join(dir, 'admin-password'), `${S}-admin-password`);
  return dir;
}
const template = await makeState(join(scratch, 'template'));

/** A copy of the template, the way the owner copies the state folder before the move. */
async function copyOf(name) {
  const out = join(scratch, name);
  await cp(template, out, { recursive: true });
  return out;
}

/** Runs the migrator with HOME and LOCALAPPDATA pointed into the scratch folder. */
async function run(args, env = {}) {
  const home = join(scratch, 'home');
  const child = spawn(process.execPath, [script, '--port', '1', ...args], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      SIPGES_MOVE_DATABASE_URL: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const [code] = await once(child, 'close');
  return { code, out };
}
const UNREACHABLE = 'postgres://nobody@127.0.0.1:1/none';
const leaks = (out) => assert.ok(!out.includes(S), 'a seeded value reached the output');

test('the original folder is the Linux sipges-local or the Windows SIPGES of LOCALAPPDATA', () => {
  assert.equal(
    originalState({ HOME: '/home/u' }, 'linux', '/home/u'),
    '/home/u/.local/share/sipges-local',
  );
  assert.equal(
    originalState({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u'),
    'C:\\Users\\u\\AppData\\Local\\SIPGES',
  );
});

test('every table is compared as identical, whatever the rules of tables.mjs allow', () => {
  const rules = strictRules({ a: {}, b: {} }, { b: {}, c: {} });
  assert.deepEqual(Object.keys(rules).sort(), ['a', 'b', 'c']);
  for (const rule of Object.values(rules)) assert.equal(rule.kind, 'identical');
});

test('refuses the original state folder and leaves it byte for byte as it was', async () => {
  const original = join(scratch, 'home', '.local', 'share', 'sipges-local');
  await mkdir(dirname(original), { recursive: true });
  await cp(template, original, { recursive: true });
  const digest = await treeDigest(join(original, 'pglite'));
  for (const given of [original, `${original}/.`, join(original, '..', 'sipges-local')]) {
    const { code, out } = await run(['--state', given, '--to', UNREACHABLE]);
    assert.equal(code, 2, out);
    assert.match(out, /original state folder/);
    leaks(out);
  }
  assert.equal(await treeDigest(join(original, 'pglite')), digest);
  await rm(original, { recursive: true, force: true });
});

test('refuses a link to a copy and a link to the original, and a database folder that is a link', async () => {
  const copy = await copyOf('copy-for-links');
  const link = join(scratch, 'link-to-copy');
  await symlink(copy, link, 'junction');
  let result = await run(['--state', link, '--to', UNREACHABLE]);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /is a link or junction/);

  const original = join(scratch, 'home', '.local', 'share', 'sipges-local');
  await mkdir(dirname(original), { recursive: true });
  await cp(template, original, { recursive: true });
  const toOriginal = join(scratch, 'link-to-original');
  await symlink(original, toOriginal, 'junction');
  result = await run(['--state', toOriginal, '--to', UNREACHABLE]);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /is a link or junction/);

  const inner = join(scratch, 'inner-link');
  await mkdir(inner);
  await symlink(join(original, 'pglite'), join(inner, 'pglite'), 'junction');
  result = await run(['--state', inner, '--to', UNREACHABLE]);
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /link or junction/);
  await rm(original, { recursive: true, force: true });
});

test('refuses a target that is not on 127.0.0.1, before reading the source', async () => {
  const copy = await copyOf('copy-for-host');
  for (const url of [
    'postgres://u@db.example:5432/x',
    'postgres://u@127.0.0.1:5432/x?host=/tmp',
    'not a url',
  ]) {
    const { code, out } = await run(['--state', copy, '--to', url]);
    assert.equal(code, 2, out);
    assert.match(out, /127\.0\.0\.1/);
    assert.ok(!out.includes('db.example'), 'the URL is never printed');
  }
});

// The PostgreSQL part: one throwaway database and login per test, dropped at the end.
const ADMIN = process.env.SIPGES_TEST_DATABASE_URL;
const pgSkip = ADMIN ? false : 'SIPGES_TEST_DATABASE_URL is not set (scripts/agents/test-pg.sh up)';
let admin;
const made = [];
before(() => {
  if (ADMIN) admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
});
after(async () => {
  if (!admin) return;
  for (const { db, role } of made.reverse()) {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
  }
  await admin.end();
});

/**
 * A fresh database owned by a fresh login that is not a superuser, as the desktop launcher
 * prepares it for the Go API (T72a), with the tenant role the migrations grant to it.
 */
async function target() {
  const id = randomBytes(4).toString('hex');
  const [db, role, password] = [`sipges_move_${id}`, `sipges_move_${id}`, randomBytes(12).toString('hex')];
  await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  made.push({ db, role });
  await admin.unsafe(`CREATE DATABASE ${db} OWNER ${role}`);
  await admin.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sipges_tenant') THEN
      CREATE ROLE sipges_tenant NOLOGIN NOINHERIT; END IF; END $$`);
  await admin.unsafe(`GRANT sipges_tenant TO ${role}`);
  const url = new URL(ADMIN);
  url.username = role;
  url.password = password;
  url.pathname = `/${db}`;
  return url.toString();
}

const counts = async (url) => {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql`SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    return row.n;
  } finally {
    await sql.end();
  }
};

test('moves a synthetic install with no difference; the source is unchanged; Go sees it migrated', { skip: pgSkip }, async (t) => {
  const copy = await copyOf('copy-to-move');
  const digest = await treeDigest(join(copy, 'pglite'));
  const url = await target();
  const { code, out } = await run(['--state', copy], { SIPGES_MOVE_DATABASE_URL: url });
  assert.equal(code, 0, out);
  assert.match(out, /RESULT: no difference/);
  assert.match(out, /module_records: 4 -> 4, identical/);
  assert.match(out, /api_keys: 2 -> 2, identical/);
  assert.match(out, /audit: 3 -> 3, identical/);
  assert.match(out, /record_links: 2 -> 2, identical/);
  assert.match(out, /schema_migrations: \d+ -> \d+, identical/);
  leaks(out);
  assert.ok(!out.includes(new URL(url).password), 'the password is never printed');
  assert.equal(await treeDigest(join(copy, 'pglite')), digest, 'the source folder changed');

  // The restored rows are what the API reads under row-level security, as the tenant role.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const visible = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE sipges_tenant`;
      await tx`SELECT set_config('app.tenant_id', ${T}, true), set_config('app.clearance', 'limited', true)`;
      return tx`SELECT id FROM module_records ORDER BY id`;
    });
    assert.deepEqual(
      visible.map((r) => r.id),
      [`${S}-AC-1`, `${S}-EV-1`],
      'tenant isolation or the restricted marking did not survive the move',
    );
  } finally {
    await sql.end();
  }

  const go = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (go.status !== 0) {
    t.skip('go is not installed: the Go migrator check did not run');
    return;
  }
  const migrateRun = spawnSync('go', ['run', './cmd/api', 'migrate'], {
    cwd: join(repo, 'apps/api-go'),
    encoding: 'utf8',
    env: {
      ...process.env,
      GOFLAGS: '-p=2',
      SIPGES_DATABASE_URL: url,
      SIPGES_MIGRATIONS_DIR: join(api, 'src/platform/database/migrations'),
      SIPGES_ALLOW_PRIVILEGED_DB_ROLE: '0',
    },
  });
  assert.equal(migrateRun.status, 0, migrateRun.stderr);
  assert.match(migrateRun.stdout, /Database up to date \(\d+ migrations known\)/);
});

test('refuses a target that already holds tables and changes nothing in it', { skip: pgSkip }, async () => {
  const url = await target();
  const first = await run(['--state', await copyOf('copy-first')], { SIPGES_MOVE_DATABASE_URL: url });
  assert.equal(first.code, 0, first.out);
  const tables = await counts(url);
  const copy = await copyOf('copy-second');
  const digest = await treeDigest(join(copy, 'pglite'));
  const { code, out } = await run(['--state', copy], { SIPGES_MOVE_DATABASE_URL: url });
  assert.equal(code, 2, out);
  assert.match(out, /target database is not empty/);
  leaks(out);
  assert.equal(await counts(url), tables);
  assert.equal(await treeDigest(join(copy, 'pglite')), digest);
});

test('refuses a superuser login: the tables would not belong to the Go API', { skip: pgSkip }, async () => {
  const copy = await copyOf('copy-superuser');
  const { code, out } = await run(['--state', copy], { SIPGES_MOVE_DATABASE_URL: ADMIN });
  assert.equal(code, 2, out);
  assert.match(out, /superuser/);
});

test('any difference exits 1 and commits nothing: the target stays empty', { skip: pgSkip }, async () => {
  const copy = await copyOf('copy-with-difference');
  const url = await target();
  const lines = [];
  const code = await runMove(
    { state: copy, to: url },
    {
      say: (line) => lines.push(line),
      original: join(scratch, 'home', '.local', 'share', 'sipges-local'),
      answers: nobody,
      // A value changed between the restore and the comparison, as a lossy restore would.
      afterRestore: (tx) => tx`UPDATE tenants SET label = label || ' cambiado'`,
    },
  );
  const out = lines.join('\n');
  assert.equal(code, 1, out);
  assert.match(out, /tenants: 2 -> 2, 2 differences/);
  assert.match(out, /RESULT: 2 differences/);
  assert.match(out, /Nothing was committed/);
  leaks(out);
  assert.equal(await counts(url), 0, 'the target kept tables after a difference');
});

const ORIGINAL = join(scratch, 'home', '.local', 'share', 'sipges-local');
const nobody = async () => false;

/** runMove in process, its lines joined; `hooks` reach runMove's second argument. */
async function move(options, hooks = {}) {
  const lines = [];
  const code = await runMove(options, {
    say: (line) => lines.push(line),
    original: ORIGINAL,
    answers: nobody,
    ...hooks,
  });
  return { code, out: lines.join('\n') };
}

// Each of these changes something the rows do not show, as a lossy restore could: the proof must
// see it, exit 1 and roll back.
const LOSSY = {
  // audit.ts has no default (0004): DROP DEFAULT there changes nothing, so module_records.marking.
  'column default dropped': [
    `ALTER TABLE module_records ALTER COLUMN marking DROP DEFAULT`,
    /column module_records\.marking: differs/,
  ],
  'sequence increment changed': [`ALTER SEQUENCE audit_id_seq INCREMENT BY 7`, /sequence public\.audit_id_seq: differs/],
  'column collation changed': [
    `ALTER TABLE audit ALTER COLUMN detail TYPE text COLLATE "C"`,
    /column audit\.detail: differs/,
  ],
  'table made unlogged': [`ALTER TABLE audit SET UNLOGGED`, /table audit: differs/],
  'storage parameter set': [`ALTER TABLE audit SET (fillfactor = 50)`, /table audit: differs/],
  'replica identity changed': [`ALTER TABLE audit REPLICA IDENTITY FULL`, /table audit: differs/],
  'table comment added': [`COMMENT ON TABLE audit IS 'x'`, /table audit: differs/],
  'default privileges added': [
    `ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO sipges_tenant`,
    /default privileges .*: new/,
  ],
};
for (const [label, [change, expected]] of Object.entries(LOSSY))
  test(`a restore that loses structure exits 1 and commits nothing: ${label}`, { skip: pgSkip }, async () => {
    const url = await target();
    const { code, out } = await move(
      { state: await copyOf(`copy-lossy-${randomBytes(3).toString('hex')}`), to: url },
      { afterRestore: (tx) => tx.unsafe(change) },
    );
    assert.equal(code, 1, out);
    assert.match(out, expected);
    assert.match(out, /Nothing was committed/);
    assert.equal(await counts(url), 0, 'the target kept tables after a difference');
  });

test('a loosened CHECK is a difference, not a re-parse', { skip: pgSkip }, async () => {
  const url = await target();
  const { code, out } = await move(
    { state: await copyOf('copy-loose-check'), to: url },
    {
      afterRestore: (tx) =>
        tx.unsafe(`ALTER TABLE media_feeds DROP CONSTRAINT media_feeds_url_check,
          ADD CONSTRAINT media_feeds_url_check CHECK (length(url) > 0)`),
    },
  );
  assert.equal(code, 1, out);
  assert.match(out, /media_feeds_url_check differs/);
});

test('refuses --scratch inside the original folder or the copy, before creating anything', async () => {
  await mkdir(dirname(ORIGINAL), { recursive: true });
  await cp(template, ORIGINAL, { recursive: true });
  const db = join(ORIGINAL, 'pglite');
  const events = [];
  const watcher = watch(db, (event, name) => events.push(`${event} ${name}`));
  const mtime = (await stat(db)).mtimeMs;
  const copy = await copyOf('copy-scratch-inside');
  try {
    for (const [given, why] of [
      [db, /inside the original state folder/],
      [ORIGINAL, /inside the original state folder/],
      [join(copy, 'pglite'), /inside the copy/],
    ]) {
      const { code, out } = await move({ state: copy, to: UNREACHABLE, scratch: given });
      assert.equal(code, 2, out);
      assert.match(out, why);
    }
    await sleep(300);
  } finally {
    watcher.close();
  }
  assert.deepEqual(events, [], 'the original pglite folder saw a file event');
  assert.equal((await stat(db)).mtimeMs, mtime);
  assert.deepEqual(
    (await readdir(join(copy, 'pglite'))).filter((n) => n.startsWith('sipges-pglite-move-')),
    [],
  );
  await rm(ORIGINAL, { recursive: true, force: true });
});

test('the signal handler removes nothing itself: the run removes the scratch copy', () => {
  const work = join(scratch, 'signal-work');
  mkdirSync(join(work, 'pglite'), { recursive: true });
  const said = [];
  const stop = { requested: false, work, committing: false };
  onSignal(stop, (line) => said.push(line));
  assert.equal(stop.requested, true);
  assert.equal(existsSync(work), true, 'the handler removed the copy itself');
  assert.match(said.join('\n'), /wait for the RESULT line/);
  rmSync(work, { recursive: true, force: true });

  said.length = 0;
  onSignal({ requested: false, work: null, committing: true }, (line) => said.push(line));
  assert.doesNotMatch(said.join('\n'), /nothing was committed/i);
});

test('a stop requested during the move rolls back, removes the scratch copy and exits 2', { skip: pgSkip }, async () => {
  const url = await target();
  const work = await mkdtemp(join(scratch, 'stop-scratch-'));
  const stop = { requested: false, work: null, committing: false };
  const { code, out } = await move(
    { state: await copyOf('copy-stopped'), to: url, scratch: work },
    {
      stop,
      afterRestore: async () => {
        stop.requested = true;
      },
    },
  );
  assert.equal(code, 2, out);
  assert.match(out, /RESULT: not moved: interrupted/);
  assert.equal(await counts(url), 0);
  assert.deepEqual(await readdir(work), []);
});

test('refuses a copy taken while SIPGES was running, in Spanish', async () => {
  const copy = await copyOf('copy-while-running');
  await writeFile(join(copy, 'pglite', 'postmaster.pid'), '-42\n');
  let result = await move({ state: copy, to: UNREACHABLE });
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /cierre SIPGES y copie la carpeta otra vez/);
  await rm(join(copy, 'pglite', 'postmaster.pid'));
  result = await move({ state: copy, to: UNREACHABLE }, { answers: async () => true });
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /SIPGES responde en el puerto 8000/);
});

test('a refused connection is reported as a connection error', async () => {
  const { code, out } = await move({ state: await copyOf('copy-refused'), to: UNREACHABLE });
  assert.equal(code, 2, out);
  assert.match(out, /could not connect to the target server \(ECONNREFUSED\)/);
  assert.doesNotMatch(out, /file system error/);
});

// Review C1: sipges-desktop --prepare-only leaves <state>/pg18.pending-move so nothing starts
// SIPGES on the empty cluster; --prepared <state> removes it only after a committed move with no
// difference. The prepared state folder is the real one (the copy is what --state reads).
async function prepared(name) {
  const dir = join(scratch, name);
  await mkdir(join(dir, 'pg18'), { recursive: true });
  await writeFile(join(dir, 'pg18.pending-move'), 'synthetic\n');
  return dir;
}

test('refuses --prepared without the pending-move mark, before reading anything', async () => {
  const copy = await copyOf('copy-prepared-unmarked');
  const unmarked = join(scratch, 'unmarked-state');
  await mkdir(unmarked, { recursive: true });
  const { code, out } = await run(['--state', copy, '--prepared', unmarked], { SIPGES_MOVE_DATABASE_URL: UNREACHABLE });
  assert.equal(code, 2, out);
  assert.match(out, /RESULT: not moved: --prepared names no folder that sipges-desktop --prepare-only prepared \(no pg18\.pending-move\)/);
});

test('a committed move with no difference removes the pending-move mark of --prepared', { skip: pgSkip }, async () => {
  const state = await prepared('prepared-ok');
  const { code, out } = await run(['--state', await copyOf('copy-prepared-ok'), '--prepared', state], { SIPGES_MOVE_DATABASE_URL: await target() });
  assert.equal(code, 0, out);
  assert.match(out, /Moved: the target holds the copy, committed\.\nThe prepared cluster is ready: removed pg18\.pending-move\./);
  assert.equal(existsSync(join(state, 'pg18.pending-move')), false);
});

test('a move with a difference keeps the pending-move mark', { skip: pgSkip }, async () => {
  const state = await prepared('prepared-different');
  const { code, out } = await move(
    { state: await copyOf('copy-prepared-different'), to: await target(), prepared: state },
    { afterRestore: (tx) => tx`UPDATE tenants SET label = label || ' cambiado'` },
  );
  assert.equal(code, 1, out);
  assert.equal(existsSync(join(state, 'pg18.pending-move')), true, 'the mark was removed after a difference');
});
