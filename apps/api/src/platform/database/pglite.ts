import type { PGliteInterface, Transaction } from '@electric-sql/pglite';
import { withoutFailingRow } from './failing-row.ts';
import type { SqlClient } from './sql-client.ts';

type PgliteLike = Pick<PGliteInterface, 'query' | 'exec'> | Transaction;

/** PGlite also copies a statement's parameters onto its errors: a hash or a seal, for any error. */
const sanitized = (error: unknown) => {
  if (typeof error === 'object' && error !== null) delete (error as { params?: unknown }).params;
  return withoutFailingRow(error);
};

const wrap = (db: PgliteLike, transaction: SqlClient['transaction']): SqlClient => ({
  query: async <Row>(text: string, params: readonly unknown[] = []) => {
    try {
      return (await db.query<Row>(text, [...params])).rows;
    } catch (error) {
      throw sanitized(error);
    }
  },
  exec: async (text) => {
    try {
      await db.exec(text);
    } catch (error) {
      throw sanitized(error);
    }
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
