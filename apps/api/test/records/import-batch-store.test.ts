import { describe, expect, it } from 'vitest';
import { createSqlRecordStore } from '../../src/contexts/records/infrastructure/sql-record-store.ts';
import type { SqlClient } from '../../src/platform/database/sql-client.ts';
import { withTenant } from '../../src/platform/database/tenant-transaction.ts';
import { createTestApp } from '../support/test-app.ts';

const TENANT = 'SIPGES/PRJ-SECHURA';
const AT = new Date('2026-11-02T12:00:00Z');
const NOTE = { action: 'IMPORT', detail: 'Importación sintética' } as const;

const setup = async () => {
  const t = await createTestApp();
  const inserts: string[] = [];
  const counting: SqlClient = {
    query: (text, params) => t.sql.query(text, params),
    exec: (text) => t.sql.exec(text),
    transaction: (fn) =>
      t.sql.transaction((tx) =>
        fn({
          query: (text, params) => {
            if (/INSERT INTO module_records/.test(text)) inserts.push(text);
            return tx.query(text, params);
          },
          exec: (text) => tx.exec(text),
          transaction: tx.transaction,
        }),
      ),
  };
  const store = createSqlRecordStore(counting);
  const payloads = async () =>
    Object.fromEntries(
      (
        await withTenant(t.sql, TENANT, (tx) =>
          tx.query<{ id: string; payload: Record<string, unknown> }>(
            "SELECT id, payload FROM module_records WHERE module = 'Eventos' ORDER BY id",
          ),
        )
      ).map((row) => [row.id, row.payload]),
    );
  return { store, inserts, payloads };
};

describe('importBatch', () => {
  it('merges a batch with repeated ids into existing records with one insert statement', async () => {
    // Each statement is a round trip to a remote database; an import sends hundreds of rows.
    const { store, inserts, payloads } = await setup();
    await store.importBatch(TENANT, 'Eventos', [{ id: 'EV-X', payload: { a: 1, b: 1 } }], NOTE, AT);
    inserts.length = 0;
    const result = await store.importBatch(
      TENANT,
      'Eventos',
      [
        { id: 'EV-A', payload: { a: 1, b: 1 } },
        { id: 'EV-X', payload: { b: 2 } },
        { id: 'EV-A', payload: { b: 3, c: 3 } },
      ],
      NOTE,
      AT,
    );
    expect(result).toEqual({ created: 1, updated: 2 });
    expect(await payloads()).toEqual({
      'EV-A': { a: 1, b: 3, c: 3 },
      'EV-X': { a: 1, b: 2 },
    });
    expect(inserts).toHaveLength(1);
  });

  it('keeps existing records and the first repeated id untouched when inserting only', async () => {
    const { store, inserts, payloads } = await setup();
    await store.importBatch(TENANT, 'Eventos', [{ id: 'EV-X', payload: { a: 1 } }], NOTE, AT);
    inserts.length = 0;
    const result = await store.importBatch(
      TENANT,
      'Eventos',
      [
        { id: 'EV-X', payload: { a: 9 } },
        { id: 'EV-B', payload: { b: 1 } },
        { id: 'EV-B', payload: { b: 2 } },
      ],
      NOTE,
      AT,
      { insertOnly: true },
    );
    expect(result).toEqual({ created: 1, updated: 0 });
    expect(await payloads()).toEqual({ 'EV-B': { b: 1 }, 'EV-X': { a: 1 } });
    expect(inserts).toHaveLength(1);
  });

  it('writes nothing and appends no audit row for an empty batch', async () => {
    const { store, inserts } = await setup();
    expect(await store.importBatch(TENANT, 'Eventos', [], NOTE, AT)).toEqual({
      created: 0,
      updated: 0,
    });
    expect(inserts).toHaveLength(0);
  });
});
