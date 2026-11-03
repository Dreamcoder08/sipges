import { describe, expect, it } from 'vitest';
import { createSqlRecordSummaryReader } from '../../src/contexts/records/infrastructure/sql-record-summary-reader.ts';
import type { SqlClient } from '../../src/platform/database/sql-client.ts';
import { createTestApp } from '../support/test-app.ts';

describe('record summary reader', () => {
  it('reads a page and its totals with one query', async () => {
    // Each query is a round trip to a remote database; Registros asks for a page at a time.
    const t = await createTestApp();
    const sent: string[] = [];
    const counting: SqlClient = {
      query: (text, params) => t.sql.query(text, params),
      exec: (text) => t.sql.exec(text),
      transaction: (fn) =>
        t.sql.transaction((tx) =>
          fn({
            query: (text, params) => {
              sent.push(text);
              return tx.query(text, params);
            },
            exec: (text) => tx.exec(text),
            transaction: tx.transaction,
          }),
        ),
    };
    const summary = await createSqlRecordSummaryReader(counting).summary(
      'SIPGES/PRJ-SECHURA',
      ['Eventos', 'Alertas'],
      { limit: 10, offset: 0, q: null },
    );
    expect(sent).toHaveLength(1);
    expect(summary).toEqual({ rows: [], counts: new Map() });
  });

  it('orders a page by requested module then newest first, with totals for every match', async () => {
    const t = await createTestApp();
    await t.sql.query(
      `INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
       SELECT 'SIPGES/PRJ-SECHURA', x.module, x.id, x.payload, x.at, x.at
       FROM jsonb_to_recordset($1::jsonb) AS x(module text, id text, payload jsonb, at timestamptz)`,
      [
        JSON.stringify([
          { module: 'Eventos', id: 'EV-1', payload: { t: 'río' }, at: '2026-11-01T10:00:00Z' },
          { module: 'Eventos', id: 'EV-2', payload: { t: 'mina' }, at: '2026-11-02T10:00:00Z' },
          { module: 'Alertas', id: 'AL-1', payload: { t: 'río' }, at: '2026-10-30T10:00:00Z' },
          { module: 'Actores', id: 'AC-1', payload: { t: 'río' }, at: '2026-11-02T11:00:00Z' },
        ]),
      ],
    );
    const reader = createSqlRecordSummaryReader(t.sql);
    const page = await reader.summary('SIPGES/PRJ-SECHURA', ['Alertas', 'Eventos'], {
      limit: 2,
      offset: 1,
      q: null,
    });
    expect(page.rows.map((r) => r.id)).toEqual(['EV-2', 'EV-1']);
    expect(page.rows[0]).toEqual({
      module: 'Eventos',
      id: 'EV-2',
      payload: { t: 'mina' },
      updatedAt: new Date('2026-11-02T10:00:00Z'),
    });
    expect(page.counts).toEqual(
      new Map([
        ['Alertas', 1],
        ['Eventos', 2],
      ]),
    );
    const searched = await reader.summary('SIPGES/PRJ-SECHURA', ['Alertas', 'Eventos'], {
      limit: 10,
      offset: 0,
      q: 'RÍO',
    });
    expect(searched.rows.map((r) => r.id)).toEqual(['AL-1', 'EV-1']);
    expect(searched.counts).toEqual(
      new Map([
        ['Alertas', 1],
        ['Eventos', 1],
      ]),
    );
  });
});
