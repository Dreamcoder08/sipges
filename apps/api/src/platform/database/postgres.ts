import postgres from 'postgres';
import type { SqlClient } from './sql-client.ts';

type Sql = postgres.Sql | postgres.TransactionSql;

const wrap = (sql: Sql, transaction: SqlClient['transaction']): SqlClient => ({
  query: async <Row>(text: string, params: readonly unknown[] = []) =>
    (await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as Row[],
  exec: async (text) => {
    // No parameters: postgres.js uses the simple protocol, which accepts several statements.
    await sql.unsafe(text);
  },
  transaction,
});

/**
 * Production adapter (postgres.js). TLS is required unless the URL targets a local host,
 * matching docs/adr/0003 guidance for managed PostgreSQL.
 */
export const postgresClient = (url: string): { client: SqlClient; close: () => Promise<void> } => {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  const sql = postgres(url, { max: 10, ssl: local ? false : 'require', prepare: false });
  const client = wrap(
    sql,
    (fn) =>
      sql.begin((tx) =>
        fn(
          wrap(tx, () => {
            throw new Error('Nested transactions are not supported');
          }),
        ),
      ) as Promise<never>,
  );
  return { client, close: () => sql.end({ timeout: 5 }) };
};
