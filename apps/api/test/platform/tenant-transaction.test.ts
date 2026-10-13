import { describe, expect, it } from 'vitest';
import { withTenant } from '../../src/platform/database/tenant-transaction.ts';
import { createTestApp } from '../support/test-app.ts';

/**
 * Proves the isolation mechanism every tenant-owned table relies on (docs/adr/0003):
 * a non-owner role plus a transaction-local tenant id evaluated by RLS policies.
 */
const setupProbeTable = async (t: Awaited<ReturnType<typeof createTestApp>>) => {
  await t.sql.exec(`
    CREATE TABLE rls_probe (tenant_id text NOT NULL, value text NOT NULL);
    ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY;
    ALTER TABLE rls_probe FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON rls_probe
      USING (tenant_id = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
    GRANT SELECT, INSERT, UPDATE, DELETE ON rls_probe TO mascli_tenant;
    INSERT INTO rls_probe VALUES ('ACME/NORTE', 'north'), ('MASCLI/PRJ-SECHURA', 'sechura');
  `);
};

describe('withTenant', () => {
  it('shows each tenant only its own rows', async () => {
    const t = await createTestApp();
    await setupProbeTable(t);
    const read = (tenant: string) =>
      withTenant(t.sql, tenant, (tx) => tx.query<{ value: string }>('SELECT value FROM rls_probe'));
    expect(await read('ACME/NORTE')).toEqual([{ value: 'north' }]);
    expect(await read('MASCLI/PRJ-SECHURA')).toEqual([{ value: 'sechura' }]);
    expect(await read('OTHER/X')).toEqual([]);
  });

  it('rejects writes into another tenant and leaves its data unchanged', async () => {
    const t = await createTestApp();
    await setupProbeTable(t);
    await expect(
      withTenant(t.sql, 'ACME/NORTE', (tx) =>
        tx.query("INSERT INTO rls_probe VALUES ('MASCLI/PRJ-SECHURA', 'intruder')"),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await withTenant(t.sql, 'ACME/NORTE', (tx) =>
      tx.query(
        "UPDATE rls_probe SET value = 'hijacked' WHERE tenant_id = 'MASCLI/PRJ-SECHURA' RETURNING 1",
      ),
    );
    expect(updated).toEqual([]);
    const all = await t.sql.query<{ value: string }>('SELECT value FROM rls_probe ORDER BY value');
    expect(all.map((r) => r.value)).toEqual(['north', 'sechura']);
  });

  it('cannot read identity tables from a tenant transaction', async () => {
    const t = await createTestApp();
    await expect(
      withTenant(t.sql, 'ACME/NORTE', (tx) => tx.query('SELECT password_hash FROM users')),
    ).rejects.toThrow(/permission denied/);
  });

  it('restores the connection role and tenant after the transaction', async () => {
    const t = await createTestApp();
    await withTenant(t.sql, 'ACME/NORTE', async () => undefined);
    const [row] = await t.sql.query<{ role: string; tenant: string | null }>(
      "SELECT current_user AS role, current_setting('app.tenant_id', true) AS tenant",
    );
    expect(row?.role).not.toBe('mascli_tenant');
    expect(row?.tenant ?? '').toBe('');
  });

  it('refuses an empty tenant id', async () => {
    const t = await createTestApp();
    await expect(withTenant(t.sql, '', async () => undefined)).rejects.toThrow(
      'Tenant id is required',
    );
  });
});
