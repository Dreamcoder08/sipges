import { describe, expect, it } from 'vitest';
import { createSqlAutomationStore } from '../../src/contexts/automation/infrastructure/sql-automation-store.ts';
import type { SqlClient } from '../../src/platform/database/sql-client.ts';
import { createTestApp } from '../support/test-app.ts';

const TENANT = 'SIPGES/PRJ-SECHURA';

describe('notification inbox', () => {
  it('reads the unread count and the latest notifications in one transaction', async () => {
    // Each transaction holds a pooled connection; the inbox is polled by every open screen.
    const t = await createTestApp();
    let transactions = 0;
    const counting: SqlClient = {
      query: (text, params) => t.sql.query(text, params),
      exec: (text) => t.sql.exec(text),
      transaction: (fn) => {
        transactions += 1;
        return t.sql.transaction(fn);
      },
    };
    const store = createSqlAutomationStore(counting);
    const at = new Date('2026-11-02T12:00:00Z');
    for (const title of ['Primera', 'Segunda'])
      await store.notify(
        TENANT,
        {
          title,
          body: 'Sintética',
          module: null,
          recordId: null,
          marking: 'interno',
          ruleId: null,
        },
        at,
      );
    transactions = 0;
    const inbox = await store.inbox(TENANT, 'analista', 1);
    expect(transactions).toBe(1);
    expect(inbox.unread).toBe(2);
    expect(inbox.items).toEqual([
      expect.objectContaining({ title: 'Segunda', read: false, createdAt: at }),
    ]);
  });
});
