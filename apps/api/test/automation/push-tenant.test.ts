import { describe, expect, it } from 'vitest';
import { createSqlPushStore } from '../../src/contexts/automation/infrastructure/index.ts';
import { createTestApp } from '../support/test-app.ts';

/**
 * The outbox runs on the login role, and PGlite's login bypasses row-level security, as a
 * superuser's would: the statements' own predicates are what keep the tenant here. The Go twin
 * is apps/api-go/internal/automation/infrastructure/push_tenant_integration_test.go.
 */
const OWN = 'SIPGES/PRJ-SECHURA';
const OTHER = 'ACME/NORTE';
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const NOW = new Date('2026-11-05T12:00:00.000Z');

const queued = async (
  sql: Awaited<ReturnType<typeof createTestApp>>['sql'],
  tenantId: string,
  person: string,
) => {
  const endpoint = `https://fcm.googleapis.com/fcm/send/synthetic-${person}`;
  await sql.query(
    `INSERT INTO users (username, full_name, password_hash, role, active, totp_enabled)
     VALUES ($1, $1, 'x', 'analista', true, true)`,
    [person],
  );
  await sql.query('INSERT INTO grants (username, tenant_id) VALUES ($1, $2)', [person, tenantId]);
  await sql.query(
    `INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, created_at)
     VALUES ($1, $2, $4, $5, $3)`,
    [endpoint, person, NOW, P256DH, AUTH],
  );
  const [row] = await sql.query<{ id: number }>(
    `WITH n AS (INSERT INTO notifications (tenant_id, title, created_at)
                VALUES ($1, 'Aviso', $3) RETURNING id)
     INSERT INTO push_deliveries (tenant_id, notification_id, endpoint, username, restricted, payload, next_attempt_at)
     SELECT $1, n.id, $2, $4, false, '{"title":"Aviso"}', $3 FROM n RETURNING id`,
    [tenantId, endpoint, NOW, person],
  );
  if (!row) throw new Error('No delivery');
  return Number(row.id);
};

const setup = async () => {
  const t = await createTestApp();
  await t.sql.query(
    `INSERT INTO tenants (company_id, project_id, label) VALUES ('ACME', 'NORTE', 'Norte')
     ON CONFLICT DO NOTHING`,
  );
  const foreign = await queued(t.sql, OTHER, 'ajena');
  const own = await queued(t.sql, OWN, 'propia');
  return { t, foreign, own, store: createSqlPushStore(t.sql) };
};

const delivery = async (sql: Awaited<ReturnType<typeof setup>>['t']['sql'], id: number) => {
  const [row] = await sql.query<{ status: string; attempts: number }>(
    'SELECT status, attempts FROM push_deliveries WHERE id = $1',
    [id],
  );
  return row;
};

describe('push outbox names the tenant in its statements', () => {
  it('claims only the deliveries of the project', async () => {
    const { t, foreign, own, store } = await setup();
    const claimed = await store.claim?.(OWN, NOW, new Date(NOW.getTime() + 60_000));
    expect(claimed?.map((d) => d.id)).toEqual([own]);
    expect((await delivery(t.sql, foreign))?.attempts).toBe(0);
  });

  it('settles only the deliveries of the project', async () => {
    const { t, foreign, own, store } = await setup();
    await store.finish?.(OWN, foreign, 'accepted', '', NOW);
    await store.finish?.(OWN, own, 'accepted', '', NOW);
    expect((await delivery(t.sql, foreign))?.status).toBe('pending');
    expect((await delivery(t.sql, own))?.status).toBe('accepted');
  });
});
