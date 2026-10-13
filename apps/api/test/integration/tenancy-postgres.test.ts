import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContainer } from '../../src/compose.ts';
import { createApp } from '../../src/app.ts';
import { createSqlTenantDataReader } from '../../src/contexts/tenancy/infrastructure/sql-tenant-data-reader.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { postgresClient } from '../../src/platform/database/postgres.ts';
import { withTenant } from '../../src/platform/database/tenant-transaction.ts';
import { TEST_ENV, TestClock } from '../support/test-app.ts';

const adminUrl = process.env.MASCLI_TEST_DATABASE_URL;
describe.skipIf(!adminUrl)('pooled PostgreSQL tenant isolation', () => {
  const name = `mascli_tenant_test_${randomBytes(6).toString('hex')}`;
  let admin: postgres.Sql;
  let pool: ReturnType<typeof postgresClient>;
  let other: ReturnType<typeof postgresClient>;
  beforeAll(async () => {
    admin = postgres(adminUrl ?? '', { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const parsed = new URL(adminUrl ?? '');
    parsed.pathname = `/${name}`;
    pool = postgresClient(parsed.toString());
    other = postgresClient(parsed.toString());
    await migrate(pool.client, await loadMigrations());
    // Real 0004 schema (forced RLS); rows inserted as the owner, read back as mascli_tenant.
    await pool.client.exec(`
      INSERT INTO tenants (company_id, project_id, label) VALUES
        ('MASCLI','PRJ-SECHURA','South'), ('ACME','NORTE','North') ON CONFLICT DO NOTHING;
      INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at) VALUES
        ('MASCLI/PRJ-SECHURA','Eventos','south','{"name":"south"}', now(), now()),
        ('ACME/NORTE','Eventos','north','{"name":"north"}', now(), now());
    `);
  });
  afterAll(async () => {
    await Promise.all([pool?.close(), other?.close()]);
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('isolates simultaneous tenant transactions across two real pools', async () => {
    const jobs = Array.from({ length: 24 }, (_, i) => {
      const north = i % 2 === 0;
      return withTenant(
        i % 3 ? pool.client : other.client,
        north ? 'ACME/NORTE' : 'MASCLI/PRJ-SECHURA',
        async (tx) => {
          await tx.query('SELECT pg_sleep(0.01)');
          expect(await tx.query('SELECT id FROM module_records')).toEqual([
            { id: north ? 'north' : 'south' },
          ]);
        },
      );
    });
    await Promise.all(jobs);
  });

  it('rejects cross-tenant and identity reads and resets pooled settings after rollback', async () => {
    await expect(
      withTenant(pool.client, 'ACME/NORTE', (tx) =>
        tx.query(
          "INSERT INTO module_records VALUES ('MASCLI/PRJ-SECHURA','Eventos','intruder','{}',now(),now())",
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(other.client, 'ACME/NORTE', (tx) => tx.query('SELECT password_hash FROM users')),
    ).rejects.toThrow(/permission denied/);
    for (const sql of [pool.client, other.client]) {
      await Promise.all(
        Array.from({ length: 10 }, async () => {
          const [row] = await sql.query<{ role: string; tenant: string | null }>(
            "SELECT current_user AS role, current_setting('app.tenant_id', true) AS tenant",
          );
          expect(row?.role).not.toBe('mascli_tenant');
          expect(row?.tenant ?? '').toBe('');
        }),
      );
    }
    expect(await pool.client.query('SELECT id FROM module_records ORDER BY id')).toEqual([
      { id: 'north' },
      { id: 'south' },
    ]);
  });

  it('exports only selected rows concurrently and restores pools after export failure', async () => {
    const readers = [
      createSqlTenantDataReader(pool.client),
      createSqlTenantDataReader(other.client),
    ];
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const north = i % 2 === 0;
        const data = await readers[i % 2]?.read({
          companyId: north ? 'ACME' : 'MASCLI',
          projectId: north ? 'NORTE' : 'PRJ-SECHURA',
        });
        expect(data?.module_records).toEqual([
          expect.objectContaining({
            tenant_id: north ? 'ACME/NORTE' : 'MASCLI/PRJ-SECHURA',
            id: north ? 'north' : 'south',
            payload: { name: north ? 'north' : 'south' },
          }),
        ]);
        expect(data?.audit).toEqual([]);
        expect(data?.attachments).toEqual([]);
      }),
    );
    await pool.client.exec('ALTER TABLE audit NO FORCE ROW LEVEL SECURITY');
    await expect(readers[0]?.read({ companyId: 'ACME', projectId: 'NORTE' })).rejects.toThrow(
      /forced tenant row-level security/,
    );
    const [role] = await pool.client.query<{ role: string }>('SELECT current_user AS role');
    expect(role?.role).not.toBe('mascli_tenant');
    await pool.client.exec('ALTER TABLE audit FORCE ROW LEVEL SECURITY');
  });

  it('serializes simultaneous administrator deactivation and preserves one active administrator', async () => {
    const container = await buildContainer({
      config: loadConfig(TEST_ENV),
      sql: pool.client,
      clock: new TestClock(),
      clientIp: () => '203.0.113.71',
    });
    const app = createApp(container);
    const login = async (username: string, password: string) => {
      const res = await app.request('/login', {
        method: 'POST',
        headers: { host: 'localhost', origin: 'http://localhost' },
        body: new URLSearchParams({ username, password }),
      });
      expect(res.status).toBe(200);
      return res.headers.get('set-cookie')?.split(';')[0] ?? '';
    };
    const cookie = await login('admin', 'admin-password-123');
    expect(
      (
        await app.request('/system/auth/accounts', {
          method: 'POST',
          headers: {
            cookie,
            host: 'localhost',
            origin: 'http://localhost',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            username: 'second.admin',
            full_name: 'Second',
            password: 'second-admin-password',
            role: 'admin',
          }),
        })
      ).status,
    ).toBe(200);
    const deactivate = (username: string) =>
      app.request(`/system/auth/accounts/${username}/deactivate`, {
        method: 'POST',
        headers: { cookie, host: 'localhost', origin: 'http://localhost' },
      });
    const results = await Promise.all([deactivate('admin'), deactivate('second.admin')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const accounts = await container.identity.listAccounts();
    expect(accounts.filter((a) => a.active && a.role === 'admin')).toHaveLength(1);
  });
});
