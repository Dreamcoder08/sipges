import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqlAlertStore } from '../../src/contexts/intelligence/infrastructure/sql-alert-store.ts';
import type { NewAlert } from '../../src/contexts/intelligence/application/ports.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';
import { postgresClient } from '../../src/platform/database/postgres.ts';
import { withTenant } from '../../src/platform/database/tenant-transaction.ts';

const adminUrl = process.env.SIPGES_TEST_DATABASE_URL;
describe.skipIf(!adminUrl)('digital evidence on real PostgreSQL connections', () => {
  const name = `sipges_digital_test_${randomBytes(6).toString('hex')}`;
  let admin: postgres.Sql;
  let pool: ReturnType<typeof postgresClient>;
  beforeAll(async () => {
    admin = postgres(adminUrl ?? '', { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const parsed = new URL(adminUrl ?? '');
    parsed.pathname = `/${name}`;
    pool = postgresClient(parsed.toString());
    await migrate(pool.client, await loadMigrations());
    await pool.client.exec(
      "INSERT INTO tenants (company_id,project_id,label) VALUES ('SYNTHETIC','ONE','Synthetic one'),('SYNTHETIC','TWO','Synthetic two')",
    );
  });
  afterAll(async () => {
    await pool?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
  const evidence = (id: string): NewAlert => ({
    id,
    projectId: 'ONE',
    createdAt: new Date('2026-10-17T12:00:00Z'),
    sourceUrl: 'https://example.org/synthetic-evidence',
    sourceType: 'Publicación digital',
    territory: 'Territorio documentado',
    sourceRecord: { module: 'Narrativas', id: 'NAR-SYNTHETIC' },
    excerpt: 'Synthetic evidence',
    sha256: 'a'.repeat(64),
    level: 'Alta',
    score: 70,
    method: 'Reglas',
    themes: [],
    signals: [],
    suggestions: [],
    semanticActive: false,
    analystNote: '',
  });
  it('serializes concurrent retries, preserves review and isolates tenants/provenance', async () => {
    const store = createSqlAlertStore(pool.client);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.create('SYNTHETIC/ONE', evidence(`DIG-SYNTHETIC-${i}`)),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(7);
    const winner = results[0];
    if (!winner) throw new Error('Expected concurrent result');
    const id = winner.id;
    await store.decide('SYNTHETIC/ONE', {
      id,
      status: 'Corroborado',
      note: 'Synthetic review',
      at: new Date('2026-10-17T12:01:00Z'),
    });
    const retry = await store.create('SYNTHETIC/ONE', evidence('DIG-RETRY'));
    expect(retry).toMatchObject({
      id,
      duplicate: true,
      status: 'Corroborado',
      reviewerNote: 'Synthetic review',
    });
    const anotherSource = await store.create('SYNTHETIC/ONE', {
      ...evidence('DIG-OTHER-SOURCE'),
      sourceRecord: { module: 'Narrativas', id: 'NAR-OTHER' },
    });
    expect(anotherSource.id).not.toBe(id);
    const anotherTenant = await store.create('SYNTHETIC/TWO', {
      ...evidence('DIG-OTHER-TENANT'),
      projectId: 'TWO',
    });
    expect(anotherTenant.id).toBe('DIG-OTHER-TENANT');
    await withTenant(pool.client, 'SYNTHETIC/ONE', async (tx) => {
      const snapshots = await tx.query<{
        event_payload: { status: string; source_record: unknown };
      }>('SELECT event_payload FROM audit WHERE record_id = $1 ORDER BY id', [id]);
      expect(snapshots.map((s) => s.event_payload.status)).toEqual([
        'Pendiente de verificación',
        'Corroborado',
      ]);
      expect(snapshots[0]?.event_payload.source_record).toEqual({
        module: 'Narrativas',
        id: 'NAR-SYNTHETIC',
      });
      const locks = await tx.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM digital_signal_dedup_locks',
      );
      expect(locks[0]?.count).toBe(2);
    });
  });
  it('deduplicates an earlier-started request even if a later timestamp won the lock', async () => {
    const store = createSqlAlertStore(pool.client);
    const first = { ...evidence('DIG-LATER-WINNER'), sha256: 'b'.repeat(64) };
    await store.create('SYNTHETIC/ONE', first);
    const retry = await store.create('SYNTHETIC/ONE', {
      ...first,
      id: 'DIG-EARLIER-RETRY',
      createdAt: new Date(first.createdAt.getTime() - 1),
    });
    expect(retry).toMatchObject({ id: first.id, duplicate: true });
  });
});
