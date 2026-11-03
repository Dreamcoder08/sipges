import { expect, it } from 'vitest';
import { createSqlIdentityStore } from '../../src/contexts/identity/infrastructure/sql-identity-store.ts';
import { createSqlTenancyStore } from '../../src/contexts/tenancy/infrastructure/sql-tenancy-store.ts';
import { declaredParameterTypes } from '../../src/platform/database/declared-types.ts';
import type { SqlClient } from '../../src/platform/database/sql-client.ts';

/** Records each statement instead of running it. */
const recording = () => {
  const sent: { text: string; params: readonly unknown[] }[] = [];
  const sql: SqlClient = {
    query: async (text, params = []) => {
      sent.push({ text, params });
      return [];
    },
    exec: async () => undefined,
    transaction: (fn) => fn(sql),
  };
  return { sql, sent };
};

it('declares every parameter of the lookups that run on each authenticated request', async () => {
  // Each runs before any screen data; an undeclared parameter costs one more round trip.
  const { sql, sent } = recording();
  await createSqlIdentityStore(sql).findSessionIdentity('a'.repeat(64), new Date());
  await createSqlTenancyStore(sql).listGrants('analista');
  expect(sent).toHaveLength(2);
  for (const { text, params } of sent)
    expect(declaredParameterTypes(text, params).every((oid) => oid > 0)).toBe(true);
});
