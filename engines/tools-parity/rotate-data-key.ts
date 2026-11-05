/**
 * Differential run of `rotate:data-key` (TypeScript) against `rotate-data-key` (Rust) on
 * synthetic databases. Sealing uses a random nonce, so tables are compared by what each value
 * opens to under the old and new keys (synthetic keys and plaintexts only).
 *
 *   SIPGES_TOOLS_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
 *     node engines/tools-parity/rotate-data-key.ts
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { createSecretCipher } from '../../apps/api/src/contexts/identity/infrastructure/secret-cipher.ts';
import type { SqlClient } from '../../apps/api/src/platform/database/sql-client.ts';
import { type Scenario, type Step, runScenarios } from './harness.ts';

const TOOL = { ts: 'apps/api/src/tools/rotate-data-key/cli.ts', rust: 'rotate-data-key' };

const OLD = Buffer.alloc(32, 1);
const NEW = Buffer.alloc(32, 2);
const OTHER = Buffer.alloc(32, 3);
const KEYS = { SIPGES_DATA_KEY: NEW.toString('base64'), SIPGES_DATA_KEY_PREVIOUS: OLD.toString('base64') };

/** Seals raw bytes (also invalid UTF-8) exactly as secret-cipher.ts does. */
const sealBytes = (key: Buffer, plain: Buffer) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `v1.${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url')}`;
};
const seal = (key: Buffer, text: string) => createSecretCipher(key).seal(text);

/** What a sealed value opens to: `new:<text>`, `old:<text>` or `unreadable`. */
const classify = (sealed: string | null) => {
  if (sealed === null) return null;
  for (const [label, key] of [
    ['new', NEW],
    ['old', OLD],
  ] as const) {
    try {
      return `${label}:${createSecretCipher(key).open(sealed)}`;
    } catch {
      // try the next key
    }
  }
  return sealed.startsWith("v1.") && sealed.length > 3 ? "unreadable" : `unreadable:${sealed}`;
};

const tenantInsert = async (sql: SqlClient, tenant: string, name: string, sealed: string) => {
  await sql.transaction(async (tx) => {
    await tx.exec(
      `SELECT set_config('app.tenant_id', '${tenant}', true), set_config('role', 'sipges_tenant', true)`,
    );
    await tx.query(
      `INSERT INTO integration_channels (tenant_id, kind, name, sealed_config, created_by, created_at)
       VALUES ($1, 'webhook', $2, $3, 'ana', '2026-01-01T00:00:00Z')`,
      [tenant, name, sealed],
    );
  });
};

const user = (sql: SqlClient, username: string, sealed: string | null) =>
  sql.query(
    `INSERT INTO users (username, full_name, password_hash, role, totp_secret_sealed, totp_enabled)
     VALUES ($1, $1, 'synthetic-hash', 'analista', $2::text, $2::text IS NOT NULL)`,
    [username, sealed],
  );

const TENANTS = ['ACME/NORTE', 'ACME/SUR', 'BETA/ESTE'];

const seedBase = async (sql: SqlClient) => {
  for (const id of TENANTS) {
    const [company, project] = id.split('/');
    await sql.query('INSERT INTO tenants (company_id, project_id, label) VALUES ($1, $2, $3)', [
      company,
      project,
      id,
    ]);
  }
  await user(sql, 'ana', seal(OLD, 'JBSWY3DPEHPK3PXP'));
  await user(sql, 'beto', seal(NEW, 'GEZDGNBVGY3TQOJQ'));
  await user(sql, 'carla', null);
  await user(sql, 'dora ñ', seal(OLD, 'secreto ñandú 😀'));
  // Invalid UTF-8 plaintext: Node decodes it with U+FFFD before re-sealing.
  await user(sql, 'eva', sealBytes(OLD, Buffer.from([0x66, 0xff, 0xfe, 0x6f, 0xe2, 0x82])));
  // Lenient base64url: junk characters, standard alphabet, a trailing part after a second dot.
  const ok = seal(OLD, 'con-ruido');
  await user(sql, 'fede', `${ok.slice(0, 10)}*\n${ok.slice(10)}`);
  await user(sql, 'gala', `${seal(OLD, 'con-sufijo')}.sobrante`);
  const std = seal(OLD, 'alfabeto-estandar').replaceAll('-', '+').replaceAll('_', '/');
  await user(sql, 'hugo', std);
  await user(sql, 'ines', sealBytes(OLD, Buffer.alloc(0)));
  for (const [i, tenant] of TENANTS.entries()) {
    await tenantInsert(sql, tenant, 'avisos', seal(OLD, JSON.stringify({ url: `https://hooks.test/${i}` })));
    await tenantInsert(sql, tenant, 'ya-nuevo', seal(NEW, '{"url":"https://hooks.test/nuevo"}'));
  }
};

/** Adds values neither key opens. */
const seedUnreadable = async (sql: SqlClient) => {
  await seedBase(sql);
  await user(sql, 'zeta', seal(OTHER, 'otra clave'));
  await tenantInsert(sql, 'ACME/SUR', 'roto', 'v1.');
  await tenantInsert(sql, 'BETA/ESTE', 'raro', 'texto plano');
};

const DUMPS = {
  users: async (sql: SqlClient) =>
    (
      await sql.query<{ username: string; sealed: string | null }>(
        'SELECT username, totp_secret_sealed AS sealed FROM users ORDER BY username',
      )
    ).map((row) => [row.username, classify(row.sealed)]),
  integration_channels: async (sql: SqlClient) =>
    (
      await sql.query<{ tenant_id: string; name: string; sealed: string }>(
        'SELECT tenant_id, name, sealed_config AS sealed FROM integration_channels ORDER BY tenant_id, name',
      )
    ).map((row) => [row.tenant_id, row.name, classify(row.sealed)]),
};

const step = (args: string[], extra: Partial<Step> = {}): Step => ({ args, env: KEYS, ...extra });

/** Fails every UPDATE of integration_channels in BETA/ESTE (the last unit). */
const failLastUnit = async (sql: SqlClient) => {
  await sql.exec(`
    CREATE FUNCTION tooldiff_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.tenant_id = 'BETA/ESTE' THEN RAISE EXCEPTION 'synthetic interruption'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER tooldiff_fail BEFORE UPDATE ON integration_channels
      FOR EACH ROW EXECUTE FUNCTION tooldiff_fail();`);
};
const unblock = (sql: SqlClient) => sql.exec('DROP TRIGGER tooldiff_fail ON integration_channels');

const REPORT = 'engines/tools-parity/.rotate-report.json';

const scenarios: Scenario[] = [
  {
    name: 'rotation',
    seed: seedBase,
    dumps: DUMPS,
    steps: [
      step(['--help']),
      step(['--', '--help']),
      step(['--nope'], { uncaught: true }),
      step(['--apply', '--dry-run'], { uncaught: true }),
      step(['--report'], { uncaught: true }),
      step(['--apply', '--', 'x'], { uncaught: true }),
      step([], { env: { SIPGES_DATA_KEY: NEW.toString('base64') } }),
      step([], { env: { ...KEYS, SIPGES_DATA_KEY_PREVIOUS: '' }, uncaught: true }),
      step([], { env: { ...KEYS, SIPGES_DATA_KEY: 'corta' }, uncaught: true }),
      step([], { env: { ...KEYS, SIPGES_DATA_KEY_PREVIOUS: KEYS.SIPGES_DATA_KEY } }),
      step([]),
      step(['--dry-run', '--report', REPORT], { files: [REPORT] }),
      step(['--report', 'engines/tools-parity/no-existe/r.json'], {}),
      step(['--apply', '--report', REPORT], { files: [REPORT] }),
      step(['--apply']),
      step(['--', '--dry-run']),
      // Rotating back: the new key is now the previous one.
      step(['--apply'], {
        env: { SIPGES_DATA_KEY: OLD.toString('base64'), SIPGES_DATA_KEY_PREVIOUS: NEW.toString('base64') },
      }),
    ],
  },
  {
    name: 'unreadable',
    seed: seedUnreadable,
    dumps: DUMPS,
    steps: [step([]), step(['--apply', `--report=${REPORT}`], { files: [REPORT] })],
  },
  {
    name: 'interrupted',
    seed: seedBase,
    dumps: DUMPS,
    prepare: failLastUnit,
    steps: [step(['--apply']), step(['--apply'], { before: unblock }), step(['--apply'])],
  },
];

process.exitCode = (await runScenarios(TOOL, scenarios)) === 0 ? 0 : 1;
