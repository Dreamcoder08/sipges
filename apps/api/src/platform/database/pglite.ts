import type { PGliteInterface, Transaction } from '@electric-sql/pglite';
import type { SqlClient } from './sql-client.ts';

type PgliteLike = Pick<PGliteInterface, 'query' | 'exec'> | Transaction;

const wrap = (db: PgliteLike, transaction: SqlClient['transaction']): SqlClient => ({
  query: async <Row>(text: string, params: readonly unknown[] = []) =>
    (await db.query<Row>(text, [...params])).rows,
  exec: async (text) => {
    await db.exec(text);
  },
  transaction,
});

/** In-process PostgreSQL (WASM) adapter for development and tests. */
export const pgliteClient = (db: PGliteInterface): SqlClient =>
  wrap(db, (fn) =>
    db.transaction((tx) =>
      fn(
        wrap(tx, () => {
          throw new Error('Nested transactions are not supported');
        }),
      ),
    ),
  );
