import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContainer } from '../../src/compose.ts';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { postgresClient } from '../../src/platform/database/postgres.ts';
import { withTenant } from '../../src/platform/database/tenant-transaction.ts';
import { TEST_ENV, TestClock, recordingSender } from '../support/test-app.ts';

const adminUrl = process.env.MASCLI_TEST_DATABASE_URL;
const CRON_SECRET = 'cron-secret-synthetic-0123456789';

/**
 * PGlite runs as a superuser, which bypasses row-level security; this suite checks the
 * automation tables as a non-superuser owner, as on a managed PostgreSQL service (ADR 0014).
 */
describe.skipIf(!adminUrl)('automation on real PostgreSQL', () => {
  const name = `mascli_automation_test_${randomBytes(6).toString('hex')}`;
  let admin: postgres.Sql;
  let pool: ReturnType<typeof postgresClient>;
  beforeAll(async () => {
    admin = postgres(adminUrl ?? '', { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const parsed = new URL(adminUrl ?? '');
    parsed.pathname = `/${name}`;
    pool = postgresClient(parsed.toString());
    await migrate(pool.client, await loadMigrations());
  });
  afterAll(async () => {
    await pool?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('lets the cron tick find tenants while rules stay isolated per tenant', async () => {
    const outbox = recordingSender();
    const container = await buildContainer({
      config: loadConfig({ ...TEST_ENV, MASCLI_CRON_SECRET: CRON_SECRET }),
      sql: pool.client,
      clock: new TestClock(),
      clientIp: () => '203.0.113.72',
      channelSender: outbox.sender,
    });
    const app = createApp(container);
    const headers = { host: 'localhost', origin: 'http://localhost' };
    const login = await app.request('/login', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ username: 'admin', password: 'admin-password-123' }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { ...headers, cookie, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    const channel = await call('POST', '/system/automations/channels', {
      kind: 'webhook',
      name: 'Receptor',
      settings: { url: 'https://receiver.example.org/x', secret: 's'.repeat(32) },
    });
    expect(channel.status).toBe(200);
    expect(
      (
        await call('POST', '/system/automations/rules', {
          name: 'Alertas',
          module: 'Alertas',
          actions: ['CREATE'],
          steps: [
            { kind: 'notify', title: 'Alerta {id}' },
            { kind: 'channel', channel_id: channel.body.id, title: 'Alerta {id}' },
          ],
        })
      ).status,
    ).toBe(200);
    await call('POST', '/api/alertas', { payload: { ID_Alerta: 'AL-PG', Nivel: 'Alto' } });

    const tick = await app.request('/system/automations/cron', {
      method: 'POST',
      headers: { host: 'localhost', authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(await tick.json()).toMatchObject({ tenants: 1, queued: 2, delivered: 2 });
    expect(outbox.sent.map((s) => s.message.title)).toEqual(['Alerta AL-PG']);
    expect((await call('GET', '/system/notifications')).body).toMatchObject({ unread: 1 });

    // Another tenant sees none of these rows, and the tenant role cannot read API keys.
    await pool.client.exec(
      "INSERT INTO tenants (company_id, project_id, label) VALUES ('ACME','NORTE','Norte') ON CONFLICT DO NOTHING",
    );
    await withTenant(pool.client, 'ACME/NORTE', async (tx) => {
      for (const table of [
        'automation_rules',
        'integration_channels',
        'automation_runs',
        'notifications',
        'automation_cursors',
      ])
        expect(await tx.query(`SELECT * FROM ${table}`), table).toEqual([]);
    });
    await expect(
      withTenant(pool.client, 'ACME/NORTE', (tx) => tx.query('SELECT * FROM api_keys')),
    ).rejects.toThrow(/permission denied/);
  });
  it('creates, authenticates and revokes API keys with an audited trail', async () => {
    const container = await buildContainer({
      config: loadConfig(TEST_ENV),
      sql: pool.client,
      clock: new TestClock(),
      clientIp: () => '203.0.113.73',
    });
    const created = await container.apiKeys.create(
      'MASCLI/PRJ-SECHURA',
      { name: 'Agente PG', access: 'read', clearance: 'limited' },
      'admin',
    );
    if (!created.ok) throw new Error('key not created');
    expect(await container.apiKeys.authenticate(created.value.token)).toMatchObject({
      tenantId: 'MASCLI/PRJ-SECHURA',
      name: 'Agente PG',
    });
    expect(await container.apiKeys.revoke('MASCLI/PRJ-SECHURA', created.value.id)).toBe(true);
    expect(await container.apiKeys.authenticate(created.value.token)).toBeNull();
    const audit = await withTenant(pool.client, 'MASCLI/PRJ-SECHURA', (tx) =>
      tx.query<{ action: string }>(
        "SELECT action FROM audit WHERE module = 'Integraciones' ORDER BY id",
      ),
    );
    expect(audit.map((a) => a.action)).toEqual(['CREATE', 'DELETE']);
  });
});
