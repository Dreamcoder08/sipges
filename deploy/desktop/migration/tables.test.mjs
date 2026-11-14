// tables.mjs against synthetic PGlite state folders built in temp folders: comparisons, the
// refusals (inputs byte-identical afterwards, nothing left in scratch) and that no seeded value
// ever reaches stdout or stderr. The fixture is the real schema (every migration applied once)
// with synthetic rows, so every ruled table exists on both sides.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RULES,
  Refusal,
  checkRoom,
  compareDatabases,
  readDatabase,
  runTables,
  safeReason,
  treeDigest,
  verdict,
} from './tables.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const script = join(here, 'tables.mjs');
const { PGlite } = await import(
  pathToFileURL(createRequire(join(repo, 'apps/api/package.json')).resolve('@electric-sql/pglite'))
    .href
);
const S = 'ZZSECRET';
// Columns with a format check hold recognisable values of that format instead of the marker.
const TOKENS = ['5ec7'.repeat(16), '7e57'.repeat(16)];
const PREFIXES = ['a1b2c3d4e5f6', 'f6e5d4c3b2a1'];
const SECRETS = [S, ...TOKENS, ...PREFIXES];
const T = `SIPGES/${S}-ALFA`;
const D = '2026-01-01T00:00:00Z';
const SEED = `
INSERT INTO tenants (company_id, project_id, label) VALUES ('SIPGES', '${S}-ALFA', '${S} Alfa');
INSERT INTO users (username, full_name, password_hash, role, totp_secret_sealed, totp_enabled,
  totp_last_step, created_at) VALUES
  ('${S}-ana', '${S} Ana', '$scrypt$${S}-hash-ana', 'admin', 'v1.${S}-mfa-ana', true, 7, '${D}'),
  ('${S}-beto', '${S} Beto', '$scrypt$${S}-hash-beto', 'analista', 'v1.${S}-mfa-beto', true, 9, '${D}');
INSERT INTO grants (username, tenant_id, created_at) VALUES ('${S}-beto', '${T}', '${D}');
INSERT INTO sessions (token_hash, username, expires_at, created_at)
  VALUES ('${TOKENS[0]}', '${S}-ana', '2030-01-01T00:00:00Z', '${D}');
INSERT INTO api_keys (tenant_id, name, prefix, secret_hash, access, clearance, created_by, created_at)
  VALUES ('${T}', '${S}-k1', '${PREFIXES[0]}', '${S}-keyhash-1', 'read', 'limited', '${S}-ana', '${D}'),
  ('${T}', '${S}-k2', '${PREFIXES[1]}', '${S}-keyhash-2', 'write', 'full', '${S}-beto', '${D}');
INSERT INTO integration_channels (tenant_id, kind, name, target_hint, sealed_config, created_by,
  created_at) VALUES ('${T}', 'webhook', '${S}-canal', '${S}.example', 'v1.${S}-sealed', '${S}-ana', '${D}');
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
  VALUES ('${T}', 'eventos', '${S}-EV-1', '{"Titulo": "${S} reunión"}', '${D}', '${D}');
INSERT INTO audit (tenant_id, ts, module, action, detail) VALUES ('${T}', '${D}', 'eventos', 'create',
  '${S} uno'), ('${T}', '${D}', 'eventos', 'update', '${S} dos'), ('${T}', '${D}', 'auth', 'login', '${S}');
INSERT INTO automation_cursors (tenant_id, last_audit_id) VALUES ('${T}', 3);`;
const MIGRATIONS_DIR = join(repo, 'apps/api/src/platform/database/migrations');

/** Every real migration, recorded in schema_migrations as the API's migrator does. */
async function migrate(db) {
  await db.exec(
    'CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL)',
  );
  for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
    await db.query('INSERT INTO schema_migrations VALUES ($1, $2)', [file.slice(0, 4), D]);
  }
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sipges-tables-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A state folder: the real schema with synthetic rows, plus the files a real one holds. */
async function state(dir) {
  await mkdir(join(dir, 'uploads'), { recursive: true });
  const db = new PGlite(join(dir, 'pglite'));
  await migrate(db);
  await db.exec(SEED);
  await db.close();
  await writeFile(join(dir, 'data-key'), `${S}-data-key`);
  await writeFile(join(dir, 'admin-password'), `${S}-admin-password`);
  await writeFile(join(dir, 'uploads', 'acta.txt'), `${S} acta`);
  return dir;
}

// Built once per file: creating a PGlite database takes seconds.
const fixtures = await mkdtemp(join(tmpdir(), 'sipges-tables-fixture-'));
after(() => rmSync(fixtures, { recursive: true, force: true }));
const templates = { base: await state(join(fixtures, 'base')) };

/** A copy of the base fixture, changed with SQL. */
async function variant(dir, name, sql = '') {
  const out = join(dir, name);
  await cp(templates.base, out, { recursive: true });
  if (sql) {
    const db = new PGlite(join(out, 'pglite'));
    await db.exec(sql);
    await db.close();
  }
  return out;
}

async function closedPort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function cli(args) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let [stdout, stderr] = ['', ''];
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}

/** Runs the CLI on two folders; checks the inputs unchanged, scratch empty and no secret printed. */
async function compareFolders(dir, before, after) {
  const scratch = join(dir, 'scratch');
  await mkdir(scratch, { recursive: true });
  const digests = [await treeDigest(before), await treeDigest(after)];
  const args = ['--before', before, '--after', after, '--scratch', scratch];
  const result = await cli([...args, '--port', String(await closedPort())]);
  assert.deepEqual([await treeDigest(before), await treeDigest(after)], digests, 'inputs changed');
  assert.deepEqual(await readdir(scratch), [], 'scratch not removed');
  assertNoSecret(result.stdout + result.stderr);
  return result;
}

function assertNoSecret(text) {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `a value was printed:\n${text}`);
}

/** Every file name under a folder, relative. */
async function names(dir) {
  return (await readdir(dir, { recursive: true })).map(String);
}

test('identical folders: one line per table and no difference', () =>
  withTemp(async (dir) => {
    const result = await compareFolders(dir, await variant(dir, 'a'), await variant(dir, 'b'));
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^Migrations applied between the two: none$/m);
    assert.match(
      result.stdout,
      /^users: 2 -> 2, identical except totp_last_step \(0032 not run between the two\)$/m,
    );
    assert.match(result.stdout, /^module_records: 1 -> 1, identical$/m);
    assert.match(result.stdout, /^sessions: ephemeral, 1 -> 1$/m);
    assert.match(result.stdout, /^Structure: compared \(/m);
    assert.match(result.stdout, /^Sequences: (\d+) -> \1, none decreased$/m);
    assert.match(
      result.stdout,
      /^automation_cursors: 1 -> 1, identical except last_tick_token, .*, last_audit_id not lower$/m,
    );
    assert.match(result.stdout, /^RESULT: no difference$/m);
  }));

test('a changed sealed value, a changed password hash and a missing row: reported, values absent', () =>
  withTemp(async (dir) => {
    const after = await variant(
      dir,
      'b',
      `UPDATE integration_channels SET sealed_config = 'v1.${S}-resealed';
       UPDATE users SET password_hash = '$scrypt$${S}-other' WHERE username = '${S}-beto';
       UPDATE users SET totp_last_step = 99; DELETE FROM api_keys WHERE id = 2;
       INSERT INTO sessions (token_hash, username, expires_at)
         VALUES ('${TOKENS[1]}', '${S}-beto', '2030-01-01T00:00:00Z');`,
    );
    const result = await compareFolders(dir, await variant(dir, 'a'), after);
    assert.equal(result.code, 1, result.stdout);
    assert.match(
      result.stdout,
      /^integration_channels: 1 -> 1, row \[[0-9a-f]{8}\] differs in sealed_config$/m,
    );
    assert.match(result.stdout, /^users: 2 -> 2, row \[[0-9a-f]{8}\] differs in password_hash$/m);
    assert.match(result.stdout, /^api_keys: 2 -> 1, row \[[0-9a-f]{8}\] missing$/m);
    assert.match(result.stdout, /^sessions: ephemeral, 1 -> 2$/m);
    assert.match(result.stdout, /^RESULT: 3 differences$/m);
  }));

test('a table without a rule leaves the run not fully compared', () =>
  withTemp(async (dir) => {
    const after = await variant(
      dir,
      'b',
      `CREATE TABLE extra (secret text); INSERT INTO extra VALUES ('${S}');`,
    );
    const result = await compareFolders(dir, await variant(dir, 'a'), after);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^extra: - -> 1, no rule$/m);
    assert.match(result.stdout, /^RESULT: not fully compared \(table extra has no rule\)$/m);
  }));

test('a database that cannot be read: not compared, no SQL or value printed, scratch removed', () =>
  withTemp(async (dir) => {
    const after = await variant(dir, 'b');
    const db = new PGlite(join(after, 'pglite'));
    const [{ path }] = (await db.query("SELECT pg_relation_filepath('module_records') AS path"))
      .rows;
    await db.close();
    await writeFile(join(after, 'pglite', path), Buffer.alloc(8192, 0x5a));
    const result = await compareFolders(dir, await variant(dir, 'a'), after);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /^RESULT: not compared \(the database could not be read \(SQLSTATE [0-9A-Z]{5}\)\)$/m,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /SELECT|module_records/);
  }));

test('SIPGES answering on the port: refused with exit 2, nothing copied', () =>
  withTemp(async (dir) => {
    const server = createServer((socket) => socket.end()).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const [before, after] = [await variant(dir, 'a'), await variant(dir, 'b')];
      const scratch = join(dir, 'scratch');
      await mkdir(scratch);
      const port = String(server.address().port);
      const result = await cli([
        '--before',
        before,
        '--after',
        after,
        '--scratch',
        scratch,
        '--port',
        port,
      ]);
      assert.equal(result.code, 2);
      assert.match(
        result.stdout,
        new RegExp(`^RESULT: not compared \\(SIPGES answers on port ${port}: `, 'm'),
      );
      assert.deepEqual(await readdir(scratch), []);
    } finally {
      server.close();
    }
  }));

/** In-process run that must refuse: the inputs are unchanged and scratch stays empty. */
async function refused(dir, options, pattern, probes = {}) {
  const scratch = options.scratch ?? join(dir, 'scratch');
  await mkdir(scratch, { recursive: true });
  const inputs = [options.before, options.after];
  const digests = await Promise.all(inputs.map((p) => treeDigest(p).catch(() => null)));
  await assert.rejects(
    runTables({ scratch, ...options }, { answers: async () => false, ...probes }),
    (error) => error instanceof Refusal && pattern.test(error.message),
  );
  assert.deepEqual(await Promise.all(inputs.map((p) => treeDigest(p).catch(() => null))), digests);
  assert.deepEqual(
    (await readdir(scratch)).filter((n) => n.startsWith('sipges-tables-')),
    [],
  );
}

test('refusals: links, same or nested folders, scratch inside an input, not a state folder', () =>
  withTemp(async (dir) => {
    const [a, b] = [await variant(dir, 'a'), await variant(dir, 'b')];
    await symlink(a, join(dir, 'link'), 'junction');
    await refused(dir, { before: join(dir, 'link'), after: b }, /is a link or junction/);
    await symlink(join(dir, 'nowhere'), join(b, 'inner-link'));
    await refused(
      dir,
      { before: a, after: b },
      /holds a link, junction or special file \(inner-link\)/,
    );
    await rm(join(b, 'inner-link'));
    await refused(dir, { before: a, after: a }, /same folder/);
    await cp(templates.base, join(a, 'nested'), { recursive: true });
    await refused(dir, { before: a, after: join(a, 'nested') }, /inside one another/);
    await rm(join(a, 'nested'), { recursive: true });
    await mkdir(join(a, 'scratch'));
    await refused(dir, { before: a, after: b, scratch: join(a, 'scratch') }, /inside an input/);
    await rm(join(a, 'scratch'), { recursive: true });
    await mkdir(join(dir, 'empty'));
    await refused(dir, { before: join(dir, 'empty'), after: b }, /not a SIPGES state folder/);
  }));

test('refusals: a database opened recently, an update running, no room in scratch', () =>
  withTemp(async (dir) => {
    const [a, b] = [await variant(dir, 'a'), await variant(dir, 'b')];
    await writeFile(join(b, 'pglite', 'postmaster.pid'), '-42\n');
    await refused(dir, { before: a, after: b }, /opened in the last 120 s/);
    await rm(join(b, 'pglite', 'postmaster.pid'));
    const root = join(dir, 'SIPGES-app');
    await mkdir(root);
    await writeFile(join(root, 'install.json'), JSON.stringify({ stateDir: b }));
    await writeFile(
      join(root, 'update.lock'),
      JSON.stringify({ pid: 1, heartbeat: new Date().toISOString() }),
    );
    await refused(dir, { before: a, after: b }, /update or first start is running/);
    await rm(join(root, 'update.lock'));
    const tiny = async () => ({ bavail: 1, bsize: 4096 });
    await refused(dir, { before: a, after: b }, /not enough free space/, { statfs: tiny });
    await assert.rejects(checkRoom(dir, 10_000, tiny), /10000 bytes needed, 4096 free/);
  }));

test('an input that changes during the run is not compared; scratch removed, also after an error', () =>
  withTemp(async (dir) => {
    const [a, b] = [await variant(dir, 'a'), await variant(dir, 'b')];
    const scratch = join(dir, 'scratch');
    await mkdir(scratch);
    const probes = { answers: async () => false };
    const changed = await runTables(
      { before: a, after: b, scratch },
      {
        ...probes,
        copied: () => writeFile(join(a, 'pglite', 'stray'), 'line\n'),
      },
    );
    assert.deepEqual(changed, {
      lines: ['RESULT: not compared (an input folder changed during the run)'],
      code: 2,
    });
    assert.deepEqual(await readdir(scratch), []);
    const boom = new Error('boom');
    await assert.rejects(
      runTables(
        { before: a, after: b, scratch },
        {
          ...probes,
          copied: async () => {
            throw boom;
          },
        },
      ),
      boom,
    );
    assert.deepEqual(await readdir(scratch), []);
  }));

// In memory: the comparison itself, with declared and injected rules. A table carries its
// structure as readDatabase reads it; these default to text columns and no keys or policies.
const t = (columns, rows, pk = [columns[0]], structure = {}) => ({
  columns,
  pk,
  rows,
  structure: {
    columns: Object.fromEntries(columns.map((c) => [c, { type: 'text', notnull: false }])),
    keys: {},
    rls: { enabled: false, forced: false },
    policies: [],
    triggers: {},
    ...structure,
  },
});
const migrations = (...v) =>
  t(
    ['version'],
    v.map((x) => [x]),
  );
const pick = (...names) => Object.fromEntries(names.map((n) => [n, RULES[n]]));
const lines = (result) => result.lines.join('\n');

test('a rule whose table is in neither database leaves the run not fully compared', () => {
  const result = verdict(compareDatabases({}, {}));
  assert.equal(result.code, 1);
  assert.match(result.line, /^RESULT: not fully compared \(/);
  const one = compareDatabases(
    { schema_migrations: migrations('0032') },
    { schema_migrations: migrations('0032') },
    { rules: pick('schema_migrations', 'users', 'grants') },
  );
  assert.equal(
    verdict(one).line,
    'RESULT: not fully compared (tables grants, users are in neither database)',
  );
});

test('added column and added table: allowed only when the rule names a migration that ran', () => {
  const rules = {
    schema_migrations: RULES.schema_migrations,
    t: { kind: 'superset', columns: { c: '0033' } },
    fresh: { kind: 'superset', addedIn: '0033' },
  };
  const was = { schema_migrations: migrations('0032'), t: t(['id'], [['1']]) };
  const now = {
    schema_migrations: migrations('0032', '0033'),
    t: t(['id', 'c'], [['1', 'x']]),
    fresh: t(['id'], [['1']]),
  };
  const ran = compareDatabases(was, now, { rules, migrations: { '0033': 'synthetic' } });
  assert.ok(ran.lines.includes('t: 1 -> 1, identical, 1 column added: c'), lines(ran));
  assert.ok(ran.lines.includes('fresh: - -> 1, new table (0033)'));
  assert.equal(verdict(ran).line, 'RESULT: no difference');
  const not = compareDatabases({ ...was, schema_migrations: migrations('0032', '0033') }, now, {
    rules,
  });
  assert.ok(not.lines.includes('t: 1 -> 1, column c new'), lines(not));
  assert.ok(not.lines.includes('fresh: - -> 1, new table'));
  assert.equal(verdict(not).line, 'RESULT: 2 differences');
  const unknown = compareDatabases(was, now, { rules });
  assert.match(
    verdict(unknown).line,
    /migration 0033 ran between the two and declares no expected change here/,
  );
});

test('expected change of 0032: satisfied, violated, and strict when 0032 did not run', () => {
  const rules = pick('schema_migrations', 'users', 'audit');
  const users = (name, hash) =>
    t(
      ['username', 'password_hash'],
      [
        [name, hash],
        ['otra', 'h2'],
      ],
    );
  const audit = (detail) =>
    t(
      ['id', 'detail'],
      [
        ['1', detail],
        ['2', 'texto'],
      ],
    );
  const was = {
    schema_migrations: migrations('0031'),
    users: users('mascli-admin', 'h1'),
    audit: audit('Aprobada (primera validación: mascli-admin)'),
  };
  const now = {
    schema_migrations: migrations('0031', '0032'),
    users: users('sipges-admin', 'h1'),
    audit: t(
      ['id', 'detail'],
      [
        ['1', 'Aprobada (primera validación: sipges-admin)'],
        ['2', 'texto'],
        ['3', 'auth'],
      ],
    ),
  };
  const ok = compareDatabases(was, now, { rules });
  assert.ok(
    ok.lines.includes(
      'users: 2 -> 2, expected change (0032): username mascli-admin -> sipges-admin in 1 row, every other value identical except totp_last_step',
    ),
    lines(ok),
  );
  assert.ok(
    ok.lines.includes(
      'audit: 2 -> 3, expected change (0032): detail templates naming mascli-admin -> sipges-admin in 1 row, every other value identical, 1 row added',
    ),
  );
  assert.equal(verdict(ok).line, 'RESULT: no difference');
  const bad = compareDatabases(was, { ...now, users: users('sipges-admin', 'h-other') }, { rules });
  assert.match(lines(bad), /^users: 2 -> 2, row \[[0-9a-f]{8}\] differs in password_hash$/m);
  const wrong = compareDatabases(was, { ...now, users: users('otro-nombre', 'h1') }, { rules });
  assert.match(lines(wrong), /row \[[0-9a-f]{8}\] missing\n {2}row \[[0-9a-f]{8}\] new/);
  const strict = compareDatabases({ ...was, schema_migrations: migrations('0031', '0032') }, now, {
    rules,
  });
  assert.match(lines(strict), /^users: 2 -> 2, 2 differences:$/m);
});

test('ephemeral tables are counted, a missing table is a difference, no key compares multisets', () => {
  const rules = { ...pick('sessions', 'tenants'), bag: { kind: 'identical' } };
  const was = {
    sessions: t(['token_hash'], [['a']]),
    tenants: t(['id'], []),
    bag: t(['v'], [['1'], ['1']], null),
  };
  const now = {
    sessions: t(['token_hash'], [['b'], ['c'], ['d']]),
    bag: t(['v'], [['1'], ['2']], null),
  };
  const result = compareDatabases(was, now, { rules });
  assert.ok(result.lines.includes('sessions: ephemeral, 1 -> 3'));
  assert.ok(result.lines.includes('tenants: 0 -> -, table missing after'));
  assert.ok(result.lines.includes('bag: 2 -> 2, 2 differences:'), lines(result));
  assert.equal(verdict(result).line, 'RESULT: 3 differences');
});

test('automation cursors: no row may vanish and last_audit_id never goes back', () => {
  const rules = pick('automation_cursors');
  const cursors = (...rows) => t(['tenant_id', 'last_audit_id', 'last_tick_status'], rows);
  const was = { automation_cursors: cursors(['A', '5', 'completed'], ['B', '9', 'completed']) };
  const run = (now) => compareDatabases(was, { automation_cursors: now }, { rules });
  const moved = run(cursors(['A', '7', 'running'], ['B', '9', 'failed'], ['C', '1', null]));
  assert.equal(verdict(moved).line, 'RESULT: no difference', lines(moved));
  assert.notEqual(RULES.automation_cursors.kind, 'ephemeral');
  const lost = run(cursors(['A', '5', 'completed']));
  assert.match(lines(lost), /^automation_cursors: 2 -> 1, row \[[0-9a-f]{8}\] missing$/m);
  const lowered = run(cursors(['A', '4', 'completed'], ['B', '9', 'completed']));
  assert.match(
    lines(lowered),
    /^automation_cursors: 2 -> 2, row \[[0-9a-f]{8}\] last_audit_id decreased$/m,
  );
  assert.equal(verdict(lowered).line, 'RESULT: 1 difference');
});

test('signal dedup keys: the app never deletes them, so none may vanish; new ones are fine', () => {
  const rules = pick('digital_signal_dedup_locks');
  const locks = (...rows) => t(['tenant_id', 'dedup_key'], rows, ['tenant_id', 'dedup_key']);
  const was = { digital_signal_dedup_locks: locks(['A', 'k1'], ['A', 'k2']) };
  const more = compareDatabases(
    was,
    { digital_signal_dedup_locks: locks(['A', 'k1'], ['A', 'k2'], ['A', 'k3']) },
    { rules },
  );
  assert.equal(verdict(more).line, 'RESULT: no difference', lines(more));
  const lost = compareDatabases(was, { digital_signal_dedup_locks: locks(['A', 'k1']) }, { rules });
  assert.match(lines(lost), /^digital_signal_dedup_locks: 2 -> 1, row \[[0-9a-f]{8}\] missing$/m);
  assert.doesNotMatch(RULES.digital_signal_dedup_locks.why, /short-lived/);
});

/** A database holding every ruled table, one row each, plus the migrations. */
function everyTable(columns = ['id'], row = ['1']) {
  const db = { schema_migrations: migrations('0031', '0032') };
  for (const name of Object.keys(RULES))
    if (name !== 'schema_migrations') db[name] = t(columns, [row]);
  return db;
}
const STRICT = ['users', 'grants', 'api_keys', 'module_records', 'tenants', 'integration_channels'];

test('a row added to or missing from every table whose rule allows no new row is a difference', () => {
  const caught = [];
  for (const [name, rule] of Object.entries(RULES)) {
    if (name === 'schema_migrations' || rule.kind === 'ephemeral' || rule.rows) continue;
    const added = compareDatabases(everyTable(), {
      ...everyTable(),
      [name]: t(['id'], [['1'], ['2']]),
    });
    const missing = compareDatabases(everyTable(), { ...everyTable(), [name]: t(['id'], []) });
    const of = (result) => result.lines.find((l) => l.startsWith(`${name}: `));
    if (/ new$/.test(of(added)) && / missing$/.test(of(missing)) && missing.differences === 1)
      caught.push(name);
  }
  for (const name of STRICT) assert.ok(caught.includes(name), `${name}: ${caught.join(', ')}`);
});

test('a column missing after is a difference in every non-ephemeral table', () => {
  const was = everyTable(['id', 'extra'], ['1', 'x']);
  const now = everyTable();
  const result = compareDatabases(was, now);
  for (const [name, rule] of Object.entries(RULES)) {
    if (name === 'schema_migrations' || rule.kind === 'ephemeral') continue;
    assert.ok(
      result.lines.includes(`${name}: 1 -> 1, column extra missing after`),
      `${name}\n${lines(result)}`,
    );
  }
  for (const name of STRICT) assert.notEqual(RULES[name].kind, 'ephemeral');
});

test('fingerprints are keyed with a new key each run and are not a plain hash', () => {
  const was = { ...everyTable(), users: t(['id'], [['ana']]) };
  const now = { ...everyTable(), users: t(['id'], []) };
  const fingerprint = (options) =>
    /^users: 1 -> 0, row \[([0-9a-f]{8})\] missing$/m.exec(
      lines(compareDatabases(was, now, options)),
    )[1];
  const [one, two] = [fingerprint(), fingerprint()];
  assert.notEqual(one, two, 'two runs gave the same fingerprint');
  const plain = createHash('sha256').update('["ana"]').digest('hex').slice(0, 8);
  assert.notEqual(one, plain);
  assert.notEqual(two, plain);
  const key = Buffer.alloc(32, 7);
  assert.equal(
    fingerprint({ key }),
    createHmac('sha256', key).update('["ana"]').digest('hex').slice(0, 8),
  );
});

test('0032 rewrites only the two audit templates; free text naming the old login stays', () => {
  const rules = pick('schema_migrations', 'audit');
  const audit = (...details) =>
    t(
      ['id', 'detail'],
      details.map((d, i) => [String(i + 1), d]),
    );
  const was = {
    schema_migrations: migrations('0031'),
    audit: audit(
      'Primera validación: mascli-admin',
      'Validada (primera validación: mascli-admin)',
      'Nota: mascli-admin revisó el acta',
      'mascli-admin',
    ),
  };
  const kept = {
    schema_migrations: migrations('0031', '0032'),
    audit: audit(
      'Primera validación: sipges-admin',
      'Validada (primera validación: sipges-admin)',
      'Nota: mascli-admin revisó el acta',
      'mascli-admin',
    ),
  };
  const ok = compareDatabases(was, kept, { rules });
  assert.equal(verdict(ok).line, 'RESULT: no difference', lines(ok));
  assert.match(lines(ok), /templates naming mascli-admin -> sipges-admin in 2 rows/);
  const rewritten = audit(
    'Primera validación: sipges-admin',
    'Validada (primera validación: sipges-admin)',
    'Nota: sipges-admin revisó el acta',
    'sipges-admin',
  );
  const bad = compareDatabases(was, { ...kept, audit: rewritten }, { rules });
  assert.match(lines(bad), /^audit: 4 -> 4, 2 differences:$/m);
});

test('structure: types, nullability, keys, row-level security, policies and triggers per table', () => {
  const rules = pick('schema_migrations', 'users', 'tenants');
  const base = () => ({
    schema_migrations: migrations('0032'),
    users: t(['username', 'totp_enabled'], [['a', 'true']], ['username'], {
      columns: {
        username: { type: 'text', notnull: true },
        totp_enabled: { type: 'boolean', notnull: true },
      },
      keys: { 'constraint users_pkey': 'PRIMARY KEY (username)' },
      rls: { enabled: true, forced: true },
      policies: ['tenant_rows'],
      triggers: { users_history: 'O' },
    }),
    tenants: t(['id'], [['x']]),
  });
  const same = compareDatabases(base(), base(), { rules });
  assert.equal(verdict(same).line, 'RESULT: no difference', lines(same));
  const now = base();
  now.users.structure = {
    columns: {
      username: { type: 'text', notnull: false },
      totp_enabled: { type: 'text', notnull: true },
    },
    keys: {},
    rls: { enabled: false, forced: true },
    policies: [],
    triggers: { users_history: 'D' },
  };
  const result = compareDatabases(base(), now, { rules });
  for (const problem of [
    'column username NOT NULL -> nullable',
    'column totp_enabled type boolean -> text',
    'constraint users_pkey missing after',
    'row-level security enabled -> disabled',
    'policy tenant_rows missing after',
    'trigger users_history enabled O -> D',
  ])
    assert.ok(result.lines.includes(`users: structure differs: ${problem}`), lines(result));
  assert.equal(verdict(result).line, 'RESULT: 6 differences');
  // An undeclared migration ran: structure changes are expected; the run is not fully compared.
  const migrated = compareDatabases(
    base(),
    { ...now, schema_migrations: migrations('0032', '0099') },
    { rules },
  );
  assert.match(lines(migrated), /^Structure: not compared \(/m);
  assert.doesNotMatch(lines(migrated), /structure differs/);
  assert.match(verdict(migrated).line, /^RESULT: not fully compared \(migration 0099/);
});

test('structure: sequences may grow, never go back or vanish', () => {
  const rules = pick('schema_migrations');
  const db = { schema_migrations: migrations('0032') };
  const run = (after) =>
    compareDatabases(db, db, { rules, sequences: [{ audit_id_seq: '5', other_seq: null }, after] });
  assert.equal(verdict(run({ audit_id_seq: '9', other_seq: '1' })).line, 'RESULT: no difference');
  const lowered = run({ audit_id_seq: '1', other_seq: null });
  assert.ok(lowered.lines.includes('sequence audit_id_seq: last value decreased'), lines(lowered));
  const reset = run({ audit_id_seq: null, other_seq: null });
  assert.ok(reset.lines.includes('sequence audit_id_seq: last value decreased'));
  const gone = run({ other_seq: null });
  assert.ok(gone.lines.includes('sequence audit_id_seq: missing after'));
  assert.equal(verdict(gone).line, 'RESULT: 1 difference');
});

test('structure read from real databases: identical passes, each kind of change is reported', () =>
  withTemp(async (dir) => {
    const read = async (folder) => {
      const db = new PGlite(join(folder, 'pglite'));
      try {
        return await readDatabase(db);
      } finally {
        await db.close();
      }
    };
    const was = await read(await variant(dir, 'a'));
    const same = await read(await variant(dir, 'b'));
    const run = (now) =>
      compareDatabases(was.tables, now.tables, { sequences: [was.sequences, now.sequences] });
    const identical = run(same);
    assert.equal(verdict(identical).line, 'RESULT: no difference', lines(identical));
    assert.match(lines(identical), /^Structure: compared \(/m);
    const policyOf = new PGlite(join(dir, 'b', 'pglite'));
    const [{ name }] = (
      await policyOf.query(
        "SELECT polname AS name FROM pg_policy WHERE polrelid = 'attachments'::regclass ORDER BY 1 LIMIT 1",
      )
    ).rows;
    await policyOf.close();
    const changed = await read(
      await variant(
        dir,
        'c',
        `ALTER TABLE users ALTER COLUMN totp_enabled DROP DEFAULT;
         ALTER TABLE users ALTER COLUMN totp_enabled TYPE text;
         ALTER TABLE irsa_snapshots DROP CONSTRAINT irsa_snapshots_pkey;
         ALTER TABLE module_records DISABLE ROW LEVEL SECURITY;
         DROP POLICY ${name} ON attachments;
         DROP TRIGGER module_records_history ON module_records;
         SELECT setval('audit_id_seq', 1);`,
      ),
    );
    const result = run(changed);
    for (const line of [
      'users: structure differs: column totp_enabled type boolean -> text',
      'irsa_snapshots: structure differs: constraint irsa_snapshots_pkey missing after',
      'module_records: structure differs: row-level security enabled -> disabled',
      `attachments: structure differs: policy ${name} missing after`,
      'module_records: structure differs: trigger module_records_history missing after',
      'sequence audit_id_seq: last value decreased',
    ])
      assert.ok(result.lines.includes(line), `${line}\n${lines(result)}`);
    assert.equal(verdict(result).line, 'RESULT: 6 differences', lines(result));
  }));

test('safeReason tells file-system codes from SQLSTATEs and never prints a message', () => {
  const error = (code, extra = {}) => Object.assign(new Error(`${S} secret text`), { code }, extra);
  assert.equal(safeReason(error('EFBIG', { syscall: 'write' })), 'file system error EFBIG (write)');
  for (const code of ['EPERM', 'EBUSY', 'EROFS'])
    assert.equal(safeReason(error(code)), `file system error ${code}`);
  assert.equal(safeReason(error('XX001')), 'the database could not be read (SQLSTATE XX001)');
  assert.equal(safeReason(error('42P01')), 'the database could not be read (SQLSTATE 42P01)');
  assert.equal(safeReason(new TypeError(`${S}`)), 'unexpected TypeError');
});

test('every table of the real migrations has a rule, and every rule a table', async () => {
  const db = new PGlite();
  await migrate(db);
  const { tables, sequences } = await readDatabase(db);
  await db.close();
  assert.deepEqual(Object.keys(tables).sort(), Object.keys(RULES).sort());
  assert.ok('audit_id_seq' in sequences);
  assert.equal(tables.users.structure.columns.totp_enabled.type, 'boolean');
});

test('only the database folder is copied: no data-key, admin-password or uploads in scratch', () =>
  withTemp(async (dir) => {
    const [a, b] = [await variant(dir, 'a'), await variant(dir, 'b')];
    // A large upload (sparse: no disk used) would not fit the scratch room if it were copied.
    const big = await open(join(b, 'uploads', 'video.bin'), 'w');
    await big.truncate(8 * 1024 ** 3);
    await big.close();
    const scratch = join(dir, 'scratch');
    await mkdir(scratch);
    let seen = [];
    const result = await runTables(
      { before: a, after: b, scratch },
      {
        answers: async () => false,
        statfs: async () => ({ bavail: 1024 ** 2, bsize: 1024 }),
        copied: async () => {
          seen = await names(scratch);
        },
      },
    );
    assert.equal(result.code, 0, result.lines.join('\n'));
    assert.ok(
      seen.some((n) => n.includes('PG_VERSION')),
      seen.join('\n'),
    );
    for (const name of seen) assert.doesNotMatch(name, /data-key|admin-password|uploads|video/);
    assert.deepEqual(await readdir(scratch), []);
  }));

test(
  'SIGINT or SIGTERM removes the scratch copies and exits 2 with not compared (interrupted)',
  {
    skip:
      process.platform === 'win32' &&
      'POSIX signals sent with child.kill are not delivered to Node on Windows',
  },
  () =>
    withTemp(async (dir) => {
      const [a, b] = [await variant(dir, 'a'), await variant(dir, 'b')];
      // A filler in the database folder makes the copy take a while.
      await writeFile(join(b, 'pglite', 'filler.bin'), Buffer.alloc(96 * 1024 ** 2));
      const digests = [await treeDigest(a), await treeDigest(b)];
      const scratch = join(dir, 'scratch');
      await mkdir(scratch);
      const port = String(await closedPort());
      for (const signal of ['SIGINT', 'SIGTERM']) {
        const args = [script, '--before', a, '--after', b, '--scratch', scratch, '--port', port];
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (chunk) => (out += chunk));
        child.stderr.on('data', (chunk) => (out += chunk));
        const exited = once(child, 'exit');
        for (let i = 0; i < 2000 && child.exitCode === null; i += 1) {
          const copies = (await names(scratch)).filter((n) => n.includes('PG_VERSION'));
          if (copies.length) break;
          await sleep(5);
        }
        assert.ok((await names(scratch)).length > 0, `scratch stayed empty before ${signal}`);
        child.kill(signal);
        const [code] = await exited;
        assert.equal(code, 2, out);
        assert.match(out, /^RESULT: not compared \(interrupted\)$/m);
        assert.deepEqual(await readdir(scratch), [], `${signal} left the copies`);
        assertNoSecret(out);
      }
      assert.deepEqual([await treeDigest(a), await treeDigest(b)], digests);
    }),
);

test('inherited object keys are not declared migration expectations', () => {
  for (const version of ['constructor', 'toString', '__proto__']) {
    const result = compareDatabases(
      { schema_migrations: migrations('0032') },
      { schema_migrations: migrations('0032', version) },
      { rules: pick('schema_migrations') },
    );
    assert.equal(verdict(result).code, 1);
    assert.ok(
      result.incomplete.includes(
        `migration ${version} ran between the two and declares no expected change here`,
      ),
      lines(result),
    );
    assert.match(lines(result), /^Structure: not compared \(/m);
  }
});

test('a table, trigger or sequence named like an Object.prototype member borrows nothing', () => {
  const base = { schema_migrations: migrations('0032') };
  for (const name of ['constructor', 'toString', '__proto__']) {
    const result = compareDatabases(
      base,
      { ...base, [name]: t(['id'], [['1']]) },
      { rules: pick('schema_migrations') },
    );
    assert.equal(verdict(result).line, `RESULT: not fully compared (table ${name} has no rule)`);
    const trigger = compareDatabases(
      base,
      {
        schema_migrations: t(['version'], [['0032']], ['version'], {
          triggers: Object.fromEntries([[name, 'O']]),
        }),
      },
      { rules: pick('schema_migrations') },
    );
    assert.ok(
      trigger.lines.includes(`schema_migrations: structure differs: trigger ${name} new`),
      lines(trigger),
    );
    const sequence = compareDatabases(base, base, {
      rules: pick('schema_migrations'),
      sequences: [{}, Object.fromEntries([[name, '5']])],
    });
    assert.ok(sequence.lines.includes(`sequence ${name}: new`), lines(sequence));
    assert.equal(verdict(sequence).code, 1);
  }
});

test('real tables named __proto__ and constructor are read and leave the run not fully compared', () =>
  withTemp(async (dir) => {
    const a = await variant(dir, 'a');
    const b = await variant(
      dir,
      'b',
      'CREATE TABLE "__proto__" (id int); CREATE TABLE "constructor" (id int);',
    );
    const scratch = join(dir, 'scratch');
    await mkdir(scratch);
    const result = await runTables(
      { before: a, after: b, scratch },
      { answers: async () => false },
    );
    assert.equal(result.code, 1, result.lines.join('\n'));
    assert.match(
      result.lines.at(-1),
      /not fully compared \(tables __proto__, constructor have no rule\)/,
    );
  }));

test('an interrupt during the copy waits for the copy in flight, then removes every copy', () =>
  withTemp(async (dir) => {
    const [a, b] = [await variant(dir, 'a'), await variant(dir, 'b')];
    const digests = [await treeDigest(a), await treeDigest(b)];
    const scratch = join(dir, 'scratch');
    await mkdir(scratch);
    const stop = { requested: false };
    let late = '';
    // The copy still writes after the signal arrived, as a copy running in a worker thread does.
    const slowCopy = async (from, to, options) => {
      await cp(from, to, options);
      stop.requested = true;
      await sleep(50);
      late = join(to, 'late.bin');
      await writeFile(late, S);
    };
    await assert.rejects(
      runTables(
        { before: a, after: b, scratch },
        { answers: async () => false, cp: slowCopy, stop },
      ),
      (error) => safeReason(error) === 'interrupted',
    );
    assert.ok(late, 'the copy in flight was not awaited');
    assert.deepEqual(await readdir(scratch), []);
    assert.deepEqual([await treeDigest(a), await treeDigest(b)], digests);
  }));

test('an interrupt at each later step still ends not compared, with nothing left', () =>
  withTemp(async (dir) => {
    const [a, b] = [await variant(dir, 'a'), await variant(dir, 'b')];
    const scratch = join(dir, 'scratch');
    await mkdir(scratch);
    const stop = { requested: false };
    await assert.rejects(
      runTables(
        { before: a, after: b, scratch },
        {
          answers: async () => false,
          stop,
          copied: async () => {
            stop.requested = true;
          },
        },
      ),
      (error) => safeReason(error) === 'interrupted',
    );
    assert.deepEqual(await readdir(scratch), []);
  }));
