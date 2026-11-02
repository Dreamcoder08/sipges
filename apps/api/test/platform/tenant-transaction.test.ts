import { describe, expect, it } from 'vitest';
import type { SqlClient } from '../../src/platform/database/sql-client.ts';
import { enterTenant, withTenant } from '../../src/platform/database/tenant-transaction.ts';
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON rls_probe TO sipges_tenant;
    INSERT INTO rls_probe VALUES ('ACME/NORTE', 'north'), ('SIPGES/PRJ-SECHURA', 'sechura');
  `);
};

describe('withTenant', () => {
  it('shows each tenant only its own rows', async () => {
    const t = await createTestApp();
    await setupProbeTable(t);
    const read = (tenant: string) =>
      withTenant(t.sql, tenant, (tx) => tx.query<{ value: string }>('SELECT value FROM rls_probe'));
    expect(await read('ACME/NORTE')).toEqual([{ value: 'north' }]);
    expect(await read('SIPGES/PRJ-SECHURA')).toEqual([{ value: 'sechura' }]);
    expect(await read('OTHER/X')).toEqual([]);
  });

  it('rejects writes into another tenant and leaves its data unchanged', async () => {
    const t = await createTestApp();
    await setupProbeTable(t);
    await expect(
      withTenant(t.sql, 'ACME/NORTE', (tx) =>
        tx.query("INSERT INTO rls_probe VALUES ('SIPGES/PRJ-SECHURA', 'intruder')"),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await withTenant(t.sql, 'ACME/NORTE', (tx) =>
      tx.query(
        "UPDATE rls_probe SET value = 'hijacked' WHERE tenant_id = 'SIPGES/PRJ-SECHURA' RETURNING 1",
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
    expect(row?.role).not.toBe('sipges_tenant');
    expect(row?.tenant ?? '').toBe('');
  });

  it('refuses an empty tenant id', async () => {
    const t = await createTestApp();
    await expect(withTenant(t.sql, '', async () => undefined)).rejects.toThrow(
      'Tenant id is required',
    );
  });

  it('enters a tenant with one statement sent to the database', async () => {
    // Each statement is one round trip to a remote database; entering a tenant runs on every request.
    const t = await createTestApp();
    const sent: string[] = [];
    await t.sql.transaction(async (tx) => {
      const counting: SqlClient = {
        query: (text, params) => {
          sent.push(text);
          return tx.query(text, params);
        },
        exec: (text) => {
          sent.push(text);
          return tx.exec(text);
        },
        transaction: tx.transaction,
      };
      await enterTenant(counting, 'ACME/NORTE');
      const [row] = await tx.query<{ role: string; tenant: string; clearance: string }>(
        "SELECT current_user AS role, current_setting('app.tenant_id') AS tenant, current_setting('app.clearance') AS clearance",
      );
      expect(row).toEqual({ role: 'sipges_tenant', tenant: 'ACME/NORTE', clearance: 'full' });
    });
    expect(sent).toHaveLength(1);
  });

  it('keeps a tenant id with quotes and backslashes as one literal value', async () => {
    const t = await createTestApp();
    await setupProbeTable(t);
    const hostile = "X\\'); SET LOCAL ROLE postgres; SELECT ('";
    const [row] = await withTenant(t.sql, hostile, (tx) =>
      tx.query<{ role: string; tenant: string; rows: number }>(
        "SELECT current_user AS role, current_setting('app.tenant_id') AS tenant, (SELECT count(*)::int FROM rls_probe) AS rows",
      ),
    );
    expect(row).toEqual({ role: 'sipges_tenant', tenant: hostile, rows: 0 });
  });

  it('refuses a tenant id with a NUL character', async () => {
    const t = await createTestApp();
    await expect(withTenant(t.sql, 'ACME\0NORTE', async () => undefined)).rejects.toThrow(
      'Tenant settings cannot contain NUL characters',
    );
  });
});
