import type { SqlClient } from './sql-client.ts';

/** Readiness: the database answers a trivial query through the same client the API uses. */
export const readinessProbe =
  (sql: Pick<SqlClient, 'query'>): (() => Promise<void>) =>
  async () => {
    await sql.query('SELECT 1');
  };
