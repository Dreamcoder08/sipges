/**
 * Driver-neutral SQL port (docs/adr/0003). Repositories write explicit, parameterized SQL
 * against this interface; PGlite and postgres.js implement it.
 */
export type SqlClient = {
  /** Runs one parameterized statement and returns its rows. */
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Runs one or more statements without parameters (migrations only). */
  exec(text: string): Promise<void>;
  /** Runs `fn` in a transaction; it commits when `fn` resolves and rolls back when it throws. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
};
