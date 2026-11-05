/**
 * Differential run of `migrate:legacy` (TypeScript) against `migrate-legacy` (Rust): the same
 * synthetic legacy installations, one synthetic PostgreSQL database and one object store per tool.
 * Compares exit code, stdout, stderr, the JSON report, every table written and every stored
 * object. Never reads data/seed.json or data/*.db.
 *
 *   SIPGES_TOOLS_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
 *     node engines/tools-parity/migrate-legacy.ts
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSecretCipher } from '../../apps/api/src/contexts/identity/infrastructure/secret-cipher.ts';
import type { SqlClient } from '../../apps/api/src/platform/database/sql-client.ts';
import { buildLegacyFixture } from '../../apps/api/test/support/legacy-fixture.ts';
import { FAKE_S3_CREDENTIALS, FAKE_S3_REGION } from './fake-s3.ts';
import { ROOT, type Scenario, type Step, SYNTHETIC_DATA_KEY, runScenarios } from './harness.ts';
import { CURRENT_SQLITE_READS, buildHostileInstallation, buildPoisoned } from './migrate-legacy-fixture.ts';

const TOOL = { ts: 'apps/api/src/tools/migrate-legacy/cli.ts', rust: 'migrate-legacy' };
const REPORT = 'engines/tools-parity/.migrate-legacy-report.json';
const scratch = mkdtempSync(join(tmpdir(), 'sipges-tooldiff-migrate-'));
const objectsOf = (tool: 'ts' | 'rs', store = 'objects') => join(scratch, store, tool);

const installations = async () => {
  const fixture = await buildLegacyFixture();
  const hostile = join(scratch, 'hostile');
  buildHostileInstallation(hostile);
  const poisoned = join(scratch, 'poisoned');
  return { fixture, hostile, poisoned };
};

const { fixture, hostile, poisoned } = await installations();

/** Texts of records and secrets seen in any output compared here; must stay empty. */
const leaks = new Set<string>();

/** Problem codes seen in reports: the run must exercise every code the tool can emit. */
const seenCodes = new Set<string>();
const declaredCodes = [
  ...readFileSync(`${ROOT}apps/api/src/tools/migrate-legacy/domain/mapping.ts`, 'utf8')
    .matchAll(/^ {2}\| '(\w+)'/gm),
].map((match) => match[1] ?? '');

const hideTimes = (text: string) => {
  for (const match of text.matchAll(/"code":"(\w+)"/g)) seenCodes.add(match[1] ?? '');
  for (const secret of [...fixture.secrets, fixture.totpSecret, 'synthetic failure with value'])
    if (text.includes(secret)) leaks.add(secret);
  return text
    .replace(/"(finishedAt|startedAt)":"[^"]+"/g, '"$1":"<time>"')
    .replace(/^\(node:\d+\) ExperimentalWarning: .*\n\(Use `node --trace-warnings.*\n/gm, '');
};

/** Local storage under each tool's own directory; the time zone TypeScript reads local dates in. */
const baseEnv = (tool: 'ts' | 'rs') => ({ SIPGES_UPLOAD_DIR: objectsOf(tool), TZ: 'UTC' });

const step = (args: readonly string[], extra: Partial<Step> = {}): Step => ({
  args,
  env: baseEnv,
  normalize: hideTimes,
  ...extra,
});

/** An uncaught TypeScript failure: Node prints a stack trace, so stderr is not compared. */
const crash = (args: readonly string[], extra: Partial<Step> = {}) =>
  step(args, { uncaught: true, ...extra });

const openedTotp = async (sql: SqlClient) => {
  const cipher = createSecretCipher(Buffer.from(SYNTHETIC_DATA_KEY, 'base64'));
  const rows = await sql.query<Record<string, unknown>>(
    `SELECT username, full_name, password_hash, role, active, created_at, totp_enabled,
       totp_secret_sealed FROM users ORDER BY username`,
  );
  return rows.map(({ totp_secret_sealed: sealed, ...row }) => ({
    ...row,
    totp: sealed === null ? null : cipher.open(sealed as string),
  }));
};

const listTree = (root: string) => {
  const out: Record<string, string> = {};
  const walk = (directory: string, prefix: string) => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else out[`${prefix}${name}`] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root, '');
  return out;
};

const TENANT_TABLES: Record<string, string> = {
  module_records: `SELECT tenant_id, module, id, payload::text AS payload, created_at, updated_at
    FROM module_records ORDER BY 1, 2, 3`,
  audit: `SELECT id, tenant_id, ts, module, record_id, action, detail FROM audit ORDER BY id`,
  irsa_configs: `SELECT tenant_id, config::text AS config FROM irsa_configs ORDER BY 1`,
  irsa_snapshots: `SELECT id, tenant_id, ts, irsa, level, scores::text AS scores, config_version, note
    FROM irsa_snapshots ORDER BY id`,
  attachments: `SELECT tenant_id, id, storage_key, original_name, content_type, size_bytes::text AS size,
      sha256, linked_module, record_module, linked_record_id, document_type, author, verification,
      notes, project_id, project_name, created_at FROM attachments ORDER BY 1, 2`,
  document_review: `SELECT tenant_id, id, project_id, source_file, source_sha256, location, theme,
      excerpt, action, status, reviewer, note, created_at, updated_at FROM document_review ORDER BY 1, 2`,
  digital_alert_reviews: `SELECT tenant_id, id, project_id, created_at, source_url, source_type, excerpt,
      sha256, level, score, method, themes::text AS themes, signals::text AS signals,
      suggestions::text AS suggestions, semantic_active, status, analyst_note, reviewer_note, reviewed_at
    FROM digital_alert_reviews ORDER BY 1, 2`,
  preventive_actions: `SELECT tenant_id, id, project_id, alert_id, title, responsible, due_date,
      description, status, progress, created_at, updated_at FROM preventive_actions ORDER BY 1, 2`,
  preventive_action_log: `SELECT tenant_id, id, action_id, created_at, status, progress, note, evidence_url
    FROM preventive_action_log ORDER BY 1, 2`,
  record_versions: `SELECT tenant_id, module, record_id, operation, payload::text AS payload
    FROM record_versions ORDER BY id`,
};

const DUMPS: Scenario['dumps'] = {
  ...TENANT_TABLES,
  users: openedTotp,
  tenants: 'SELECT tenant_id, company_id, project_id, label FROM tenants ORDER BY 1',
  grants: 'SELECT username, tenant_id FROM grants ORDER BY 1, 2',
  objects: async (_sql, tool) => listTree(objectsOf(tool)),
};

const addUser = async (sql: SqlClient) => {
  await sql.query(
    `INSERT INTO users (username, full_name, password_hash, role, created_at)
     VALUES ('legacy.admin', 'Bootstrap', 'x', 'admin', '2026-01-02T03:04:05Z')`,
  );
};

const fail = (table: string, when: string, name = 'tooldiff_fail') => `
  CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF ${when} THEN RAISE EXCEPTION 'synthetic failure with value %', NEW; END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}();`;

const legacy = ['--legacy-root', fixture.root];
const rough = ['--legacy-root', hostile];

const poison = (name: string, write: (root: string) => void) => {
  const root = join(poisoned, name);
  buildPoisoned(root, fixture.root);
  write(root);
  return ['--legacy-root', root];
};

const sqlite = (path: string, sql: string) => {
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
};

const startFakeS3 = async (): Promise<{ child: ChildProcess; port: number }> => {
  const child = spawn(process.execPath, [`${ROOT}engines/tools-parity/fake-s3.ts`, join(scratch, 's3')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout?.once('data', (data: Buffer) => resolve(Number(String(data).trim())));
    child.once('exit', () => reject(new Error('fake S3 exited')));
  });
  return { child, port };
};

const s3 = await startFakeS3();

const s3Env =
  (bucket: string) =>
  (tool: 'ts' | 'rs'): Record<string, string> => ({
    TZ: 'UTC',
    SIPGES_STORAGE: 's3',
    SIPGES_S3_ENDPOINT: `http://127.0.0.1:${s3.port}/ignored/path`,
    SIPGES_S3_REGION: FAKE_S3_REGION,
    SIPGES_S3_BUCKET: bucket === 'side' ? `synthetic bucket ${tool}` : bucket,
    SIPGES_S3_ACCESS_KEY_ID: FAKE_S3_CREDENTIALS.accessKeyId,
    SIPGES_S3_SECRET_ACCESS_KEY: FAKE_S3_CREDENTIALS.secretAccessKey,
  });

const refusals: Step[] = [
  step(['--help']),
  step(['--help', ...legacy, '--apply']),
  step([]),
  step(['--dry-run']),
  crash(['--legacy-root']),
  crash(['--legacy-root=']),
  crash(['--auth-db=', ...legacy]),
  crash(['--report=', ...legacy]),
  crash(['--nope', ...legacy]),
  crash(['posicional']),
  crash(['--', ...legacy]),
  crash(['--apply=1', ...legacy]),
  crash(['--apply', '--verify', ...legacy]),
  crash(['--apply', '--verify', '--help']),
  crash(['--only', 'sin-barra', ...legacy]),
  crash(['--only=a/b/c', ...legacy]),
  crash(['--only=', '--help']),
  crash(['--legacy-root', join(scratch, 'no-existe')]),
  crash(legacy, { env: (tool) => ({ ...baseEnv(tool), SIPGES_DATA_KEY: 'corta' }) }),
  crash(legacy, { env: (tool) => ({ ...baseEnv(tool), SIPGES_STORAGE: 'ftp' }) }),
  crash(legacy, { env: (tool) => ({ ...baseEnv(tool), SIPGES_STORAGE: 's3' }) }),
  crash(legacy, { env: (tool) => ({ ...s3Env('x')(tool), SIPGES_S3_ENDPOINT: 'http://example.test' }) }),
  crash(legacy, { env: (tool) => ({ ...s3Env('x')(tool), SIPGES_S3_ENDPOINT: 'no es una url' }) }),
  crash(['--report', join(scratch, 'no-existe', 'r.json'), ...legacy]),
];

const scenarios: Scenario[] = [
  { name: 'refusals', seed: async () => {}, dumps: DUMPS, steps: refusals },
  {
    name: 'whole flow',
    seed: async () => {},
    dumps: DUMPS,
    steps: [
      step(legacy),
      step([...legacy, '--dry-run', '--report', REPORT], { files: [REPORT] }),
      step([...legacy, '--verify']),
      step([...legacy, '--apply', '--report', REPORT], { files: [REPORT] }),
      step([...legacy, '--apply', '--report', REPORT], { files: [REPORT] }),
      step([...legacy, '--apply', '--allow-non-empty', '--report', REPORT], { files: [REPORT] }),
      step([...legacy, '--verify', '--report', REPORT], { files: [REPORT] }),
      step([...legacy, '--verify', '--only', 'ACME/PRJ-NORTE']),
      step([...legacy, '--dry-run', '--apply', '--only=SIPGES/PRJ-SECHURA']),
    ],
  },
  {
    name: 'only',
    seed: async () => {},
    dumps: DUMPS,
    steps: [
      step([...legacy, '--only', 'NO/EXISTE']),
      step([...legacy, '--only', 'ACME/PRJ-NORTE', '--only', 'NO/EXISTE', '--apply', '--report', REPORT], {
        files: [REPORT],
      }),
      step([...legacy, '--only', 'SIPGES/PRJ-SECHURA', '--apply', '--allow-non-empty']),
    ],
  },
  {
    name: 'hostile rows',
    seed: async () => {},
    dumps: DUMPS,
    steps: [
      step([...rough, '--report', REPORT], { files: [REPORT] }),
      step([...rough, '--apply', '--report', REPORT], { files: [REPORT] }),
      step([...rough, '--verify', '--report', REPORT], { files: [REPORT] }),
    ],
  },
  {
    name: 'path overrides',
    seed: async () => {},
    dumps: DUMPS,
    steps: [
      step([
        '--legacy-root',
        join(scratch, 'vacío'),
        `--auth-db=${join(fixture.root, 'data/auth_global.db')}`,
        `--default-db=${join(fixture.root, 'data/sipges.db')}`,
        `--tenant-dir=${join(fixture.root, 'data/../data/tenants')}`,
        `--upload-dir=${join(fixture.root, 'data/uploads/')}`,
        `--config-dir=${join(fixture.root, 'data')}`,
        '--apply',
      ]),
    ],
  },
  {
    name: 'occupied target',
    seed: addUser,
    dumps: DUMPS,
    steps: [
      step(legacy),
      step([...legacy, '--apply', '--report', REPORT], { files: [REPORT] }),
      step([...legacy, '--apply', '--allow-non-empty', '--report', REPORT], { files: [REPORT] }),
      step([...legacy, '--verify', '--report', REPORT], { files: [REPORT] }),
    ],
  },
  {
    name: 'tampered target',
    seed: async () => {},
    dumps: { ...DUMPS, objects: async () => null },
    steps: [
      step([...legacy, '--apply']),
      step([...legacy, '--verify', '--report', REPORT], {
        files: [REPORT],
        before: async (sql, tool) => {
          await sql.transaction(async (tx) => {
            await tx.exec(`SELECT set_config('app.tenant_id', 'SIPGES/PRJ-SECHURA', true)`);
            await tx.query(`UPDATE module_records SET payload = '{"x":1}' WHERE id = 'A-SYN-01'`);
            await tx.query(`DELETE FROM document_review`);
          });
          await sql.query(`UPDATE users SET full_name = 'Otro' WHERE username = 'legacy.admin'`);
          await sql.query(
            `INSERT INTO users (username, full_name, password_hash, role, created_at)
             VALUES ('extra', 'E', 'x', 'admin', '2026-01-02T03:04:05Z')`,
          );
          await sql.query(`UPDATE tenants SET label = 'Otro' WHERE tenant_id = 'ACME/PRJ-NORTE'`);
          await sql.query(`DELETE FROM grants WHERE username = 'legacy.analyst'`);
          await sql.query(`INSERT INTO grants (username, tenant_id) VALUES ('extra', 'ACME/PRJ-NORTE')`);
          const [first, ...others] = Object.keys(listTree(objectsOf(tool)));
          rmSync(join(objectsOf(tool), first ?? 'none'));
          for (const key of others) writeFileSync(join(objectsOf(tool), key), 'alterado');
        },
      }),
    ],
  },
  {
    name: 'one tenant fails',
    seed: async () => {},
    dumps: DUMPS,
    prepare: (sql) => sql.exec(fail('module_records', "NEW.id = 'A-SYN-91'")),
    steps: [
      step([...legacy, '--apply', '--report', REPORT], { files: [REPORT] }),
      step([...legacy, '--verify']),
      step([...legacy, '--apply', '--allow-non-empty', '--report', REPORT], {
        files: [REPORT],
        before: (sql) => sql.exec('DROP TRIGGER tooldiff_fail ON module_records'),
      }),
      step([...legacy, '--verify']),
    ],
  },
  {
    name: 'identity fails',
    seed: async () => {},
    dumps: DUMPS,
    prepare: (sql) => sql.exec(fail('grants', "NEW.username = 'legacy.analyst'")),
    steps: [step([...legacy, '--apply', '--report', REPORT], { files: [REPORT] })],
  },
  {
    name: 'broken installations',
    seed: async () => {},
    dumps: DUMPS,
    steps: [
      crash(poison('big-integer', (root) => sqlite(join(root, 'data/sipges.db'), 'CREATE TABLE records2(a); DROP TABLE audit; CREATE TABLE audit(id, ts, module, record_id, action, detail, extra); INSERT INTO audit VALUES (1, 1, 2, 3, 4, 5, 9007199254740992)'))),
      ...(CURRENT_SQLITE_READS ? [crash(poison('smallest-integer', (root) => sqlite(join(root, 'data/sipges.db'), 'DROP TABLE audit; CREATE TABLE audit(id, ts, module, record_id, action, detail); INSERT INTO audit VALUES (1, -9223372036854775808, 2, 3, 4, 5)')))] : []),
      crash(poison('garbage-auth', (root) => writeFileSync(join(root, 'data/auth_global.db'), 'no es sqlite, relleno suficiente'.repeat(50)))),
      crash(poison('garbage-tenant', (root) => writeFileSync(join(root, 'data/sipges.db'), 'tampoco es sqlite'.repeat(100)))),
      crash(poison('directory-db', (root) => {
        rmSync(join(root, 'data/sipges.db'));
        mkdirSync(join(root, 'data/sipges.db'));
      })),
      crash(poison('missing-column', (root) => sqlite(join(root, 'data/sipges.db'), 'DROP TABLE attachments; CREATE TABLE attachments(id)'))),
      crash(poison('deep-json', (root) => {
        const payload = `{"x":${'['.repeat(5000)}1${']'.repeat(5000)}}`;
        const db = new DatabaseSync(join(root, 'data/sipges.db'));
        db.prepare(`INSERT INTO records VALUES ('Eventos', 'EV-HONDO', ?, '2026-01-01', '2026-01-01')`).run(payload);
        db.close();
      })),
      step(poison('no-tables', (root) => {
        rmSync(join(root, 'data/sipges.db'));
        sqlite(join(root, 'data/sipges.db'), 'CREATE TABLE otra(a)');
      })),
    ],
  },
  {
    name: 'S3 storage',
    seed: async () => {},
    dumps: {
      ...DUMPS,
      objects: async (_sql, tool) => listTree(join(scratch, 's3', `synthetic bucket ${tool}`)),
    },
    steps: [
      step([...legacy, '--apply', '--report', REPORT], { env: s3Env('side'), files: [REPORT] }),
      step([...legacy, '--verify', '--report', REPORT], { env: s3Env('side'), files: [REPORT] }),
      crash([...legacy, '--verify'], { env: s3Env('deny-get') }),
    ],
  },
  {
    // fetch refuses a value past Latin-1 or with a line break; other bytes go out and sign alike.
    name: 'S3 content types',
    seed: async () => {},
    dumps: {
      ...DUMPS,
      objects: async (_sql, tool) => listTree(join(scratch, 's3', `synthetic bucket ${tool}`)),
    },
    steps: ['text/plain; charset=é', '  a   b  ', 'tipo😀', 'a\nb'].map((type, i) =>
      step(
        [
          ...poison(`content-type-${i}`, (root) => {
            const db = new DatabaseSync(join(root, 'data/sipges.db'));
            db.prepare('UPDATE attachments SET content_type = ?').run(type);
            db.close();
          }),
          '--apply',
          '--allow-non-empty',
          '--only=SIPGES/PRJ-SECHURA',
          '--report',
          REPORT,
        ],
        {
          env: s3Env('side'),
          files: [REPORT],
          before: (sql) =>
            sql.exec(`TRUNCATE tenants, users CASCADE`),
        },
      ),
    ),
  },
  {
    name: 'S3 refuses writes',
    seed: async () => {},
    dumps: DUMPS,
    steps: [step([...legacy, '--apply', '--report', REPORT], { env: s3Env('deny-put'), files: [REPORT] })],
  },
];

try {
  const differences = await runScenarios(TOOL, scenarios);
  if (leaks.size > 0) console.error(`LEAK in tool output: ${leaks.size} marker(s)`);
  const unseen = declaredCodes.filter((code) => !seenCodes.has(code));
  if (unseen.length > 0) console.error(`NOT EXERCISED: ${unseen.join(', ')}`);
  const stored = Object.keys(listTree(join(scratch, 's3', 'synthetic bucket rs'))).length;
  if (stored === 0) console.error('NOT EXERCISED: nothing reached the S3 server');
  console.info(`${seenCodes.size} problem codes seen, ${stored} files on the S3 server`);
  process.exitCode =
    differences === 0 && leaks.size === 0 && unseen.length === 0 && stored > 0 ? 0 : 1;
} finally {
  s3.child.kill();
  await fixture.cleanup();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(`${ROOT}${REPORT}`, { force: true });
}
