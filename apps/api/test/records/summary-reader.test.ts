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
});
