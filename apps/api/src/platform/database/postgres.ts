import postgres from 'postgres';
import { declaredParameterTypes } from './declared-types.ts';
import { withoutFailingRow } from './failing-row.ts';
import type { SqlClient } from './sql-client.ts';

type Sql = postgres.Sql | postgres.TransactionSql;
type Typed = postgres.Sql['typed'];

/** Declares the types the SQL already casts to, so the query goes out in one round trip. */
const withDeclaredTypes = (typed: Typed, text: string, params: readonly unknown[]) => {
  const oids = declaredParameterTypes(text, params);
  return params.map((value, index) => {
    const oid = oids[index];
    return oid ? typed(value as never, oid) : value;
  }) as postgres.ParameterOrJSON<never>[];
};

/**
 * `query` and `exec` must both stay `async` wrappers that await the driver: postgres.js hands a
 * query to the connection a fixed number of microtasks after it is awaited, so statements keep
 * the order they were called in. withTenant relies on that to send a transaction's first query
 * right behind its tenant settings (tenant-transaction.ts).
 */
const wrap = (sql: Sql, typed: Typed, transaction: SqlClient['transaction']): SqlClient => ({
  query: async <Row>(text: string, params: readonly unknown[] = []) => {
    try {
      return (await sql.unsafe(text, withDeclaredTypes(typed, text, params))) as unknown as Row[];
    } catch (error) {
      throw withoutFailingRow(error);
    }
  },
  exec: async (text) => {
    try {
      // No parameters: postgres.js uses the simple protocol, which accepts several statements.
      await sql.unsafe(text);
    } catch (error) {
      throw withoutFailingRow(error);
    }
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
    // On connect postgres.js would query pg_type for custom array types: one more round trip on
    // every new connection, and the Worker opens one per request. SIPGES uses built-in types
    // only (no CREATE TYPE or extension types), which postgres.js already knows.
    fetch_types: false,
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
    sql.typed,
    (fn) =>
      sql.begin((tx) =>
        fn(
          wrap(tx, sql.typed, () => {
            throw new Error('Nested transactions are not supported');
          }),
        ),
      ) as Promise<never>,
  );
  return { client, close: () => sql.end({ timeout: 5 }) };
};
