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

/** Driver settings a host can override; the defaults suit a long-lived Node process. */
export type PostgresOptions = {
  readonly max?: number;
  /** Cloudflare Hyperdrive documents that postgres.js without prepared statements can hang. */
  readonly prepare?: boolean;
  /** Overrides the TLS choice made from the URL, for hosts that manage TLS themselves. */
  readonly ssl?: false | 'require';
};

/**
 * Production adapter (postgres.js). TLS is required unless the URL targets a local host,
 * matching docs/adr/0003 guidance for managed PostgreSQL.
 */
export const postgresClient = (
  url: string,
  options: PostgresOptions = {},
): { client: SqlClient; close: () => Promise<void> } => {
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  const sql = postgres(url, {
    max: options.max ?? 10,
    ssl: options.ssl ?? (local ? false : 'require'),
    prepare: options.prepare ?? false,
    types: {
      /**
       * Repositories pass JSON *text* for `json`/`jsonb` parameters (`$n::jsonb`). postgres.js
       * learns the server-inferred parameter type after Parse and then applies its own JSON
       * serializer, which would encode that text a second time and store a JSON string
       * (breaking `jsonb_typeof(payload) = 'object'`). Pass strings through unchanged.
       */
      json: {
        to: 114,
        from: [114, 3802],
        serialize: (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value)),
        parse: (value: string) => JSON.parse(value) as unknown,
      },
    },
  });
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
