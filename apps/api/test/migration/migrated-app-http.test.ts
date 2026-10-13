/**
 * End-to-end check of a migrated installation: the synthetic legacy databases are migrated
 * into the real application database, and everything afterwards goes through the HTTP app —
 * login with a legacy password hash, scoped records, tenant isolation (S7), attachment bytes
 * and the tenant export.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSecretCipher } from '../../src/contexts/identity/infrastructure/secret-cipher.ts';
import { totp } from '../../src/contexts/identity/infrastructure/totp.ts';
import { moduleForSlug } from '../../src/contexts/records/application/index.ts';
import { runMigration } from '../../src/tools/migrate-legacy/application/migrate.ts';
import { createSqlTargetStore } from '../../src/tools/migrate-legacy/infrastructure/sql-target-store.ts';
import {
  createSqliteLegacySource,
  legacyLayout,
} from '../../src/tools/migrate-legacy/infrastructure/sqlite-legacy-source.ts';
import { buildLegacyFixture, type LegacyFixture } from '../support/legacy-fixture.ts';
import { TEST_DATA_KEY, createTestApp, memoryStorage } from '../support/test-app.ts';

describe('migrated installation through the HTTP app', () => {
  let fixture: LegacyFixture;
  beforeAll(async () => {
    fixture = await buildLegacyFixture();
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  const setup = async () => {
    const storage = memoryStorage();
    const t = await createTestApp({}, { objectStorage: storage.storage });
    const source = createSqliteLegacySource(legacyLayout(fixture.root));
    try {
      // The app bootstraps its own admin and default tenant, so the target is never empty.
      const report = await runMigration(
        {
          source,
          target: createSqlTargetStore(
            t.sql,
            createSecretCipher(Buffer.from(TEST_DATA_KEY, 'base64')),
          ),
          storage: storage.storage,
          moduleForSlug,
          now: () => t.clock.now(),
        },
        { mode: 'apply', allowNonEmptyTarget: true },
      );
      expect(report.applied).toBe(true);
      return { t, storage, report };
    } finally {
      source.close();
    }
  };

  const get = (
    t: Awaited<ReturnType<typeof createTestApp>>,
    path: string,
    cookie: string,
    scope?: string,
  ) =>
    t.request(path, {
      headers: { cookie, ...(scope ? { 'x-mascli-scope': scope } : {}) },
    });

  it('lets a migrated user sign in with the legacy password and read their records', async () => {
    const { t } = await setup();
    const login = await t.login(fixture.adminUser, fixture.password);
    expect(login.res.status).toBe(200);

    const res = await get(t, '/api/eventos', login.cookie, fixture.defaultTenant);
    expect(res.status).toBe(200);
    const events = (await res.json()) as { _id: string; Titulo: string }[];
    expect(events.map((e) => e._id)).toEqual([fixture.eventId]);
    expect(events[0]?.Titulo).toBe('Reunion sintetica sur');

    // Legacy PBKDF2 hashes are rehashed to Argon2id on the first successful login.
    const [user] = await t.sql.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE username = $1',
      [fixture.adminUser],
    );
    expect(user?.password_hash.startsWith('$argon2id$')).toBe(true);
  });

  it('keeps the migrated TOTP enrolment working', async () => {
    const { t } = await setup();
    const withoutCode = await t.login(fixture.analystUser, fixture.password);
    expect(withoutCode.res.status).toBe(401);

    const code = totp.codeAt(fixture.totpSecret, t.clock.now());
    const login = await t.login(fixture.analystUser, fixture.password, code);
    expect(login.res.status).toBe(200);
  });

  it('isolates tenants after the migration (S7)', async () => {
    const { t } = await setup();
    const login = await t.login(fixture.adminUser, fixture.password);

    // Granted on both scopes: each scope sees only its own record.
    const north = await get(t, '/api/eventos', login.cookie, fixture.otherTenant);
    expect(north.status).toBe(200);
    expect(((await north.json()) as { _id: string }[]).map((e) => e._id)).toEqual([
      fixture.otherEventId,
    ]);
    const crossRecord = await get(
      t,
      `/api/eventos/${fixture.otherEventId}`,
      login.cookie,
      fixture.defaultTenant,
    );
    expect(crossRecord.status).toBe(404);
    const crossAttachment = await get(
      t,
      `/system/uploads/${fixture.otherAttachmentId}`,
      login.cookie,
      fixture.defaultTenant,
    );
    expect(crossAttachment.status).toBe(404);

    // The bootstrap administrator was never granted the migrated scope.
    const other = await t.login('admin', 'admin-password-123');
    const denied = await get(t, '/api/eventos', other.cookie, fixture.otherTenant);
    expect(denied.status).toBe(403);
  });

  it('downloads migrated attachment bytes and exports the tenant', async () => {
    const { t } = await setup();
    const login = await t.login(fixture.adminUser, fixture.password);

    const meta = await get(
      t,
      `/system/uploads/${fixture.attachmentId}`,
      login.cookie,
      fixture.defaultTenant,
    );
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      id: fixture.attachmentId,
      original_name: 'evidencia.txt',
      linked_record_id: fixture.eventId,
    });

    const download = await get(
      t,
      `/system/uploads/${fixture.attachmentId}/download`,
      login.cookie,
      fixture.defaultTenant,
    );
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(fixture.attachmentBytes);

    const exported = await get(t, '/system/export', login.cookie, fixture.defaultTenant);
    expect(exported.status).toBe(200);
    const body = (await exported.json()) as {
      scope: { company_id: string; project_id: string };
      data: Record<string, unknown[]>;
    };
    expect(body.scope).toEqual({ company_id: 'MASCLI', project_id: 'PRJ-SECHURA' });
    expect(body.data['module_records']).toHaveLength(2);
    expect(body.data['attachments']).toHaveLength(1);
    expect(body.data['document_review']).toHaveLength(1);
    expect(body.data['preventive_actions']).toHaveLength(1);
  });

  it('serves migrated IRSA configuration and history', async () => {
    const { t } = await setup();
    const login = await t.login(fixture.adminUser, fixture.password);

    const config = await get(t, '/system/irsa/config', login.cookie, fixture.defaultTenant);
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({ version: '0.4-sintetica' });

    const history = await get(t, '/system/irsa/history', login.cookie, fixture.defaultTenant);
    expect(history.status).toBe(200);
    expect((await history.json()) as unknown[]).toHaveLength(1);
  });
});
