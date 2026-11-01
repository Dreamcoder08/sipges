import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { buildContainer } from '../../src/compose.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { pgliteClient } from '../../src/platform/database/pglite.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import {
  memoryStorage,
  offlineEmbeddings,
  ORIGIN,
  recordingSender,
  TEST_ENV,
  TestClock,
} from '../support/test-app.ts';
import { trackTestDatabase } from '../support/test-database.ts';

const VERSION = '0032_rename_admin_username';
const OLD = 'mascli-admin';
const NEW = 'sipges-admin';
const LOOKALIKE = 'mascli-admin2';
const PASSWORD = 'admin-password-123';
const TENANT = 'SIPGES/PRJ-SECHURA';
const OTHER = 'SIPGES/PRJ-ALGARROBO';
const ALERT_REFUSAL = 'Otra persona debe confirmar la validación de una alerta de prioridad Alta';

/** The columns that hold the account name or an attribution to it, matched on the exact value. */
const RENAMED = [
  'users.username',
  'sessions.username',
  'grants.username',
  'push_subscriptions.username',
  'push_deliveries.username',
  'notification_reads.username',
  'api_keys.created_by',
  'integration_channels.created_by',
  'automation_rules.created_by',
  'record_links.created_by',
  'record_versions.actor',
  'link_evidence_history.actor',
  'attachments.author',
  'document_review.reviewer',
  'proposal_decisions.decided_by',
  'preventive_action_log.decided_by',
  'preventive_actions.responsible',
  'digital_alert_reviews.first_validator',
  'project_settings.updated_by',
  'source_import_settings.updated_by',
  'media_feeds.updated_by',
];

type Row = Record<string, unknown>;
type Snapshot = Record<string, string[]>;

/**
 * What the migration must leave in a column, given what was there. Two columns name the
 * account inside a fixed template instead of holding it alone: login_failures.subject and
 * audit.detail.
 */
const renamed = (table: string, column: string, value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const key = `${table}.${column}`;
  if (key === 'login_failures.subject') return value === `user:${OLD}` ? `user:${NEW}` : value;
  if (key === 'audit.detail')
    return value
      .replace(/^Primera validación: mascli-admin$/, `Primera validación: ${NEW}`)
      .replace(/ \(primera validación: mascli-admin\)$/, ` (primera validación: ${NEW})`);
  return RENAMED.includes(key) && value === OLD ? NEW : value;
};

type Server = Awaited<ReturnType<typeof serve>>;

/** The real application over a database, as the Worker builds it with the given admin name. */
const serve = async (db: PGlite, adminUsername: string) => {
  const container = await buildContainer({
    config: loadConfig({ ...TEST_ENV, SIPGES_ADMIN_USERNAME: adminUsername }),
    sql: pgliteClient(db),
    clock: new TestClock(),
    clientIp: () => '203.0.113.1',
    objectStorage: memoryStorage().storage,
    embeddings: offlineEmbeddings,
    narrator: null,
    channelSender: recordingSender().sender,
    pushSender: null,
    feedGateway: { read: () => Promise.reject(new Error('feed_unresolved')) },
  });
  const app = createApp(container);
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('host', 'localhost');
    if ((init.method ?? 'GET') !== 'GET') headers.set('origin', ORIGIN);
    return app.request(path, { ...init, headers });
  };
  const login = async (username: string, password: string) => {
    const res = await request('/login', {
      method: 'POST',
      body: new URLSearchParams({ username, password, otp: '' }),
    });
    const token = /sipges_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
    return { status: res.status, cookie: `sipges_session=${token}`, token };
  };
  const call = (method: string, path: string, cookie: string, body?: unknown) =>
    request(path, {
      method,
      headers: {
        cookie,
        'x-sipges-scope': TENANT,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
  return { request, login, call, json };
};

const decide = (server: Server, id: string, status: string, cookie: string) =>
  server.call('PATCH', `/system/intelligence/territorial-alerts/${id}`, cookie, { status });

/**
 * A database migrated up to the migration before the rename, with the administrator
 * `mascli-admin` signed in, and an attribution to it in every column that can hold one.
 */
const database = async () => {
  const db = trackTestDatabase(new PGlite());
  const all = await loadMigrations();
  await migrate(
    pgliteClient(db),
    all.filter((m) => m.version < VERSION),
  );
  const server = await serve(db, OLD);
  const admin = await server.login(OLD, PASSWORD);
  expect(admin.token).not.toBe('');

  for (const [username, role] of [
    ['ana', 'coordinador'],
    [LOOKALIKE, 'consulta'],
  ] as const) {
    const made = await server.call('POST', '/system/auth/accounts', admin.cookie, {
      username,
      full_name: 'Synthetic',
      password: 'synthetic-pass-123',
      role,
    });
    expect(made.status).toBe(200);
    const granted = await server.call('POST', '/system/auth/grants', admin.cookie, {
      username,
      company_id: 'SIPGES',
      project_id: 'PRJ-SECHURA',
    });
    expect(granted.status).toBe(200);
  }
  const ana = await server.login('ana', 'synthetic-pass-123');
  await server.login(LOOKALIKE, 'synthetic-pass-123');

  // A high-priority alert the administrator was the first to validate (four eyes, ADR 0024).
  const created = await server.json(
    await server.call('POST', '/system/intelligence/territorial-alerts', admin.cookie, {
      text: 'Convocatoria sintética a asamblea por agua limpia.',
      mode: 'rules',
    }),
  );
  const alert = String(created.id);
  await db.query(`UPDATE digital_alert_reviews SET level = 'Alta' WHERE id = $1`, [alert]);
  expect((await decide(server, alert, 'Corroborado', admin.cookie)).status).toBe(200);

  await db.exec(`
    UPDATE users SET google_email = 'admin@example.org' WHERE username = '${OLD}';
    INSERT INTO tenants (company_id, project_id, label) VALUES ('SIPGES', 'PRJ-ALGARROBO', 'Algarrobo');
    INSERT INTO grants (username, tenant_id) VALUES ('${OLD}', '${OTHER}');

    INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, created_at) VALUES
      ('https://push.example.org/1', '${OLD}', repeat('A', 87), repeat('B', 22), now()),
      ('https://push.example.org/2', 'ana', repeat('A', 87), repeat('B', 22), now());
    INSERT INTO login_failures (subject, failed_at) VALUES
      ('user:${OLD}', now()), ('user:${LOOKALIKE}', now()), ('ip:203.0.113.9', now());

    INSERT INTO notifications (tenant_id, title, body, created_at) OVERRIDING SYSTEM VALUE
      VALUES ('${TENANT}', 'Aviso', 'Revisado por ${OLD}', now());
    INSERT INTO notification_reads (tenant_id, notification_id, username, read_at)
      SELECT '${TENANT}', id, u, now() FROM notifications, unnest(ARRAY['${OLD}', 'ana']) u;
    INSERT INTO push_deliveries (tenant_id, notification_id, endpoint, username, restricted, payload,
        next_attempt_at)
      SELECT '${TENANT}', id, 'https://push.example.org/1', '${OLD}', false, '{}', now()
      FROM notifications;

    INSERT INTO api_keys (tenant_id, name, prefix, secret_hash, access, clearance, created_by, created_at)
      VALUES ('${TENANT}', 'k1', 'aaaaaaaaaaaa', 'h', 'read', 'full', '${OLD}', now()),
             ('${TENANT}', 'k2', 'bbbbbbbbbbbb', 'h', 'read', 'full', 'ana', now());
    INSERT INTO integration_channels (tenant_id, kind, name, sealed_config, created_by, created_at)
      VALUES ('${TENANT}', 'webhook', 'c1', 'x', '${OLD}', now());
    INSERT INTO automation_rules (tenant_id, name, trigger_module, trigger_actions, actions, created_by,
        created_at, updated_at)
      VALUES ('${TENANT}', 'r1', 'Demandas', '{CREATE}', '[]', '${OLD}', now(), now());

    INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at, marking)
      VALUES ('${TENANT}', 'Demandas', 'D-1', '{"Responsable": "${OLD}", "Nota": "de ${OLD}"}',
              now(), now(), 'interno'),
             ('${TENANT}', 'Demandas', 'D-2', '{}', now(), now(), 'interno'),
             ('${TENANT}', 'Demandas', 'D-3', '{}', now(), now(), 'interno');
    INSERT INTO record_links (tenant_id, link_type, source_module, source_id, target_module, target_id,
        created_by, created_at)
      VALUES ('${TENANT}', 'related', 'Demandas', 'D-1', 'Demandas', 'D-2', '${OLD}', now()),
             ('${TENANT}', 'related', 'Demandas', 'D-1', 'Demandas', 'D-3', '${LOOKALIKE}', now());
    INSERT INTO link_evidence_history (tenant_id, link_id, actor, at)
      SELECT '${TENANT}', id, '${OLD}', now() FROM record_links WHERE created_by = '${OLD}';
    INSERT INTO record_versions (tenant_id, module, record_id, operation, payload, actor, at) VALUES
      ('${TENANT}', 'Demandas', 'D-1', 'UPDATE', '{"Responsable": "${OLD}"}', '${OLD}', now()),
      ('${TENANT}', 'Demandas', 'D-1', 'UPDATE', '{}', 'ana', now());

    INSERT INTO attachments (tenant_id, id, storage_key, original_name, content_type, size_bytes, sha256,
        linked_module, record_module, linked_record_id, document_type, author, verification, notes,
        project_id, project_name, created_at)
      VALUES ('${TENANT}', 'ATT-1', 'k1', 'f.pdf', 'application/pdf', 1, repeat('a', 64), 'Demandas',
              'Demandas', 'D-1', 'x', '${OLD}', 'x', 'Subido por ${OLD}', 'PRJ-SECHURA', 'Sechura', now()),
             ('${TENANT}', 'ATT-2', 'k2', 'g.pdf', 'application/pdf', 1, repeat('b', 64), 'Demandas',
              'Demandas', 'D-1', 'x', '${LOOKALIKE}', 'x', '', 'PRJ-SECHURA', 'Sechura', now());
    INSERT INTO document_review (tenant_id, id, project_id, source_file, source_sha256, location, theme,
        excerpt, action, status, created_at, updated_at, reviewer)
      VALUES ('${TENANT}', 'DR-1', 'PRJ-SECHURA', 'f.pdf', repeat('a', 64), 'p1', 't', 'e', 'a',
              'pendiente', now(), now(), '${OLD}');
    INSERT INTO proposal_decisions (tenant_id, fingerprint, subject_module, subject_id, kind, decision,
        decided_by, decided_at)
      VALUES ('${TENANT}', 'f1', 'Demandas', 'D-1', 'link', 'approved', '${OLD}', now()),
             ('${TENANT}', 'f2', 'Demandas', 'D-1', 'link', 'rejected', 'ana', now());

    INSERT INTO preventive_actions (tenant_id, id, project_id, alert_id, title, responsible, due_date,
        description, status, progress, created_at, updated_at)
      VALUES ('${TENANT}', 'ACC-1', 'PRJ-SECHURA', '${alert}', 'A1', '${OLD}', '2026-12-01', 'd',
              'Pendiente', 0, now(), now()),
             ('${TENANT}', 'ACC-2', 'PRJ-SECHURA', '${alert}', 'A2', '${OLD} Pérez', '2026-12-01', 'd',
              'Pendiente', 0, now(), now());
    INSERT INTO preventive_action_log (tenant_id, id, action_id, created_at, status, progress, note,
        decided_by)
      VALUES ('${TENANT}', 'LOG-1', 'ACC-1', now(), 'Pendiente', 0, 'n', '${OLD}'),
             ('${TENANT}', 'LOG-2', 'ACC-1', now(), 'Pendiente', 0, 'n', 'ana');

    INSERT INTO project_settings (tenant_id, settings, updated_by, updated_at)
      VALUES ('${TENANT}', '{"nota": "${OLD}"}', '${OLD}', now()),
             ('${OTHER}', '{}', 'ana', now());
    INSERT INTO source_import_settings (tenant_id, source_id, updated_by, updated_at)
      VALUES ('${TENANT}', 'defensoria', '${OLD}', now());
    INSERT INTO media_feeds (tenant_id, name, url, authorization_note, updated_by, updated_at)
      VALUES ('${TENANT}', 'M1', 'https://example.org/feed', 'ok', '${OLD}', now());

    INSERT INTO audit (tenant_id, ts, module, action, detail) VALUES
      ('${TENANT}', now(), 'InteligenciaDigital', 'REVIEW', 'Corroborado (primera validación: ana)'),
      ('${TENANT}', now(), 'InteligenciaDigital', 'REVIEW', 'Corroborado (primera validación: ${OLD})'),
      ('${TENANT}', now(), 'InteligenciaDigital', 'REVIEW', 'Primera validación: ana'),
      ('${TENANT}', now(), 'InteligenciaDigital', 'REVIEW', 'Corroborado (primera validación: ${LOOKALIKE})'),
      ('${TENANT}', now(), 'Importación', 'CREATE', 'Importado por ${OLD} desde la fuente');
  `);
  return { db, all, server, admin, ana, alert };
};

/** Every row of every table, as sorted JSON per table, to compare states exactly. */
const snapshot = async (db: PGlite): Promise<Snapshot> => {
  const tables = (
    await db.query<{ relname: string }>(
      `SELECT relname FROM pg_class
       WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
         AND relname <> 'schema_migrations' ORDER BY relname`,
    )
  ).rows;
  const out: Snapshot = {};
  for (const { relname } of tables) {
    const rows = await db.query<{ row: Row }>(`SELECT to_jsonb(t) AS row FROM "${relname}" t`);
    out[relname] = rows.rows.map((r) => JSON.stringify(r.row)).sort();
  }
  return out;
};

/** The snapshot with the account renamed in the attribution columns, and nothing else changed. */
const withRename = (snap: Snapshot): Snapshot =>
  Object.fromEntries(
    Object.entries(snap).map(([table, rows]) => [
      table,
      rows
        .map((row) =>
          JSON.stringify(
            Object.fromEntries(
              Object.entries(JSON.parse(row) as Row).map(([column, value]) => [
                column,
                renamed(table, column, value),
              ]),
            ),
          ),
        )
        .sort(),
    ]),
  );

/** Row security, foreign keys, triggers, policies and privileges: the structure around the data. */
const form = async (db: PGlite) => ({
  shapes: (
    await db.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity, relacl::text AS acl FROM pg_class
       WHERE relkind IN ('r', 'S') AND relnamespace = 'public'::regnamespace ORDER BY relname`,
    )
  ).rows,
  columnPrivileges: (
    await db.query(
      `SELECT attrelid::regclass::text AS rel, attname, attacl::text AS acl FROM pg_attribute
       WHERE attacl IS NOT NULL ORDER BY 1, 2`,
    )
  ).rows,
  foreignKeys: (
    await db.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated, condeferrable FROM pg_constraint
       WHERE contype = 'f' AND connamespace = 'public'::regnamespace ORDER BY conname`,
    )
  ).rows,
  triggers: (
    await db.query(
      `SELECT tgrelid::regclass::text AS rel, tgname, tgenabled FROM pg_trigger
       WHERE NOT tgisinternal ORDER BY 1, 2`,
    )
  ).rows,
  policies: (
    await db.query(
      `SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies ORDER BY 1, 2`,
    )
  ).rows,
});

const versions = async (db: PGlite) =>
  (
    await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY 1')
  ).rows.map((r) => r.version);

const textColumns = async (db: PGlite) =>
  (
    await db.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
         AND c.data_type IN ('text', 'character varying', 'character')
       ORDER BY 1, 2`,
    )
  ).rows;

/** Rows holding exactly the given value, per `table.column`, over every text column. */
const holding = async (db: PGlite, value: string) => {
  const found: Record<string, number> = {};
  for (const { table_name: table, column_name: column } of await textColumns(db)) {
    const n = (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`,
        [value],
      )
    ).rows[0]?.n;
    if (n) found[`${table}.${column}`] = n;
  }
  return found;
};

describe(`migration ${VERSION}`, () => {
  it('renames the account and every attribution to it, and nothing else', async () => {
    const { db, all } = await database();
    const before = await snapshot(db);
    const structure = await form(db);
    const applied = await versions(db);
    const user = (await db.query<Row>('SELECT * FROM users WHERE username = $1', [OLD])).rows[0];
    const grantsBefore = (
      await db.query('SELECT tenant_id FROM grants WHERE username = $1 ORDER BY 1', [OLD])
    ).rows;

    // The seed reaches every column the migration is expected to rename.
    const seeded = await holding(db, OLD);
    for (const column of RENAMED)
      expect(seeded[column], `${column} is not seeded`).toBeGreaterThan(0);
    const seededSubjects = await db.query(
      `SELECT 1 FROM login_failures WHERE subject = 'user:${OLD}'`,
    );
    expect(seededSubjects.rows).toHaveLength(1);
    // Both templates the alert store writes: the first validation (through the real route) and
    // the later decisions that quote the first validator.
    const seededDetails = await db.query<{ detail: string }>(
      `SELECT detail FROM audit WHERE detail ~ 'alidación: ${OLD}\\)?$' ORDER BY detail`,
    );
    expect(seededDetails.rows.map((r) => r.detail)).toEqual([
      'Corroborado (primera validación: mascli-admin)',
      'Primera validación: mascli-admin',
    ]);

    expect(await migrate(pgliteClient(db), all)).toEqual([VERSION]);

    // Only the attribution columns changed; every other value, decoy included, is as it was.
    expect(await snapshot(db)).toEqual(withRename(before));
    expect(await holding(db, OLD)).toEqual({});
    const after = await holding(db, NEW);
    for (const column of RENAMED)
      expect(after[column], `${column} was not renamed`).toBe(seeded[column]);

    // The account is the same one: role, password hash and Google link carry over.
    const renamedUser = (await db.query<Row>('SELECT * FROM users WHERE username = $1', [NEW]))
      .rows[0];
    expect(renamedUser).toEqual({ ...user, username: NEW });
    expect((await db.query('SELECT 1 FROM users WHERE username = $1', [OLD])).rows).toEqual([]);
    expect(
      (await db.query('SELECT tenant_id FROM grants WHERE username = $1 ORDER BY 1', [NEW])).rows,
    ).toEqual(grantsBefore);
    expect((await db.query('SELECT 1 FROM sessions WHERE username = $1', [NEW])).rows).toHaveLength(
      1,
    );
    expect(
      (await db.query('SELECT 1 FROM push_subscriptions WHERE username = $1', [NEW])).rows,
    ).toHaveLength(1);

    // Row security, foreign keys, triggers, policies and privileges are exactly as before.
    expect(await form(db)).toEqual(structure);
    expect(await versions(db)).toEqual([...applied, VERSION].sort());

    // The audit trail stays append-only for the application role.
    const privileges = await db.query<{ insert: boolean; update: boolean; remove: boolean }>(
      `SELECT has_table_privilege('sipges_tenant', 'audit', 'INSERT') AS insert,
              has_table_privilege('sipges_tenant', 'audit', 'UPDATE') AS update,
              has_table_privilege('sipges_tenant', 'audit', 'DELETE') AS remove`,
    );
    expect(privileges.rows).toEqual([{ insert: true, update: false, remove: false }]);

    // Applying the SQL again finds no such account and changes nothing.
    const done = await snapshot(db);
    await db.exec(all.find((m) => m.version === VERSION)?.sql ?? '');
    expect(await snapshot(db)).toEqual(done);
  });

  it('signs in as sipges-admin, no longer as mascli-admin, and keeps open sessions', async () => {
    const { db, all, admin } = await database();
    expect(await migrate(pgliteClient(db), all)).toEqual([VERSION]);

    // The Worker now starts with SIPGES_ADMIN_USERNAME=sipges-admin.
    const server = await serve(db, NEW);
    const old = await server.login(OLD, PASSWORD);
    expect(old.status).toBe(401);
    expect(old.token).toBe('');
    const fresh = await server.login(NEW, PASSWORD);
    expect(fresh.status).toBeLessThan(400);
    expect(fresh.token).not.toBe('');
    const wrong = await server.login(NEW, 'not-the-password-1');
    expect(wrong.status).toBe(401);

    for (const cookie of [fresh.cookie, admin.cookie]) {
      const me = await server.json(await server.call('GET', '/system/auth/me', cookie));
      expect(me).toMatchObject({ username: NEW, role: 'admin', active: 1 });
    }
    const scopes = await server.call('GET', '/system/auth/scopes', admin.cookie);
    expect(JSON.stringify(await scopes.json())).toContain('PRJ-ALGARROBO');
    expect((await db.query('SELECT 1 FROM users')).rows).toHaveLength(3);
  });

  it('still sees one person for the four-eyes rule: the first validator cannot confirm', async () => {
    const { db, all, admin, ana, alert } = await database();
    expect(await migrate(pgliteClient(db), all)).toEqual([VERSION]);
    const server = await serve(db, NEW);
    const current = await server.login(NEW, PASSWORD);

    const read = async () =>
      server.json(
        await server.call(
          'GET',
          `/system/intelligence/territorial-alerts/${alert}`,
          current.cookie,
        ),
      );
    expect(await read()).toMatchObject({
      status: 'Pendiente de verificación',
      first_validator: NEW,
    });

    // The proposal was validated first by mascli-admin: sipges-admin is that same person.
    for (const cookie of [current.cookie, admin.cookie]) {
      const refused = await decide(server, alert, 'Corroborado', cookie);
      expect(refused.status).toBe(409);
      expect(await server.json(refused)).toEqual({ detail: ALERT_REFUSAL });
    }
    expect(await read()).toMatchObject({ status: 'Pendiente de verificación' });

    // A different person still can.
    const confirmed = await decide(server, alert, 'Corroborado', ana.cookie);
    expect(confirmed.status).toBe(200);
    expect(await read()).toMatchObject({ status: 'Corroborado', first_validator: NEW });
  });

  it('stops when sipges-admin already exists and changes nothing', async () => {
    const { db, all } = await database();
    await db.exec(`
      INSERT INTO users (username, full_name, password_hash, role)
        VALUES ('${NEW}', 'Someone else', 'h', 'analista');
      INSERT INTO grants (username, tenant_id) VALUES ('${NEW}', '${TENANT}');
    `);
    const before = await snapshot(db);
    const structure = await form(db);
    const applied = await versions(db);

    await expect(migrate(pgliteClient(db), all)).rejects.toMatchObject({
      message: `Migration ${VERSION} failed`,
      cause: { message: expect.stringMatching(/sipges-admin already exists/) },
    });

    expect(await snapshot(db)).toEqual(before);
    expect(await versions(db)).toEqual(applied);
    expect(await form(db)).toEqual(structure);
    expect(Object.keys(await holding(db, OLD)).length).toBeGreaterThan(10);
  });

  it('changes nothing when mascli-admin does not exist', async () => {
    const { db, all } = await database();
    // The account is gone (its sessions, grants and subscriptions with it); history stays.
    await db.query('DELETE FROM users WHERE username = $1', [OLD]);
    const before = await snapshot(db);
    const structure = await form(db);

    expect(await migrate(pgliteClient(db), all)).toEqual([VERSION]);

    expect(await snapshot(db)).toEqual(before);
    expect(await form(db)).toEqual(structure);
    expect(Object.keys(await holding(db, OLD)).length).toBeGreaterThan(10);
  });

  it('stops on a leftover in a column it does not rename, and changes nothing', async () => {
    const { db, all } = await database();
    await db.exec(
      `INSERT INTO notifications (tenant_id, title, created_at) VALUES ('${TENANT}', '${OLD}', now())`,
    );
    const before = await snapshot(db);
    const structure = await form(db);

    await expect(migrate(pgliteClient(db), all)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/notifications\.title/) },
    });

    expect(await snapshot(db)).toEqual(before);
    expect(await form(db)).toEqual(structure);
    expect((await versions(db)).includes(VERSION)).toBe(false);
  });

  it('renames as a table owner without BYPASSRLS, where forced RLS hides the rows', async () => {
    const { db, all } = await database();
    const before = await snapshot(db);
    // A managed PostgreSQL owner role: forced RLS applies to it, so it sees no tenant rows.
    await db.exec(`
      CREATE ROLE rename_owner NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c
                 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' LOOP
          EXECUTE format('ALTER TABLE %s OWNER TO rename_owner', r.rel);
        END LOOP;
        FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace LOOP
          EXECUTE format('ALTER FUNCTION %s OWNER TO rename_owner', r.fn);
        END LOOP;
      END
      $$;
      GRANT USAGE, CREATE ON SCHEMA public TO rename_owner;
    `);
    const structure = await form(db);
    await db.exec('SET ROLE rename_owner');
    try {
      expect(await migrate(pgliteClient(db), all)).toEqual([VERSION]);
    } finally {
      await db.exec('RESET ROLE');
    }

    expect(await snapshot(db)).toEqual(withRename(before));
    expect(await holding(db, OLD)).toEqual({});
    expect(await form(db)).toEqual(structure);
  });
});
