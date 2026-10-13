import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { AppConfig } from '../config.ts';
import { pgliteClient } from './pglite.ts';
import { postgresClient } from './postgres.ts';
import type { SqlClient } from './sql-client.ts';

/** Opens PostgreSQL when configured, otherwise the embedded PGlite directory (development only). */
export const openDatabase = async (
  config: AppConfig,
): Promise<{ sql: SqlClient; close: () => Promise<void> }> => {
  if (config.databaseUrl) {
    const { client, close } = postgresClient(config.databaseUrl);
    return { sql: client, close };
  }
  await mkdir(config.pgliteDir, { recursive: true });
  const db = new PGlite(config.pgliteDir);
  console.warn(`MASCLI is using embedded PGlite at ${config.pgliteDir} (development only).`);
  return { sql: pgliteClient(db), close: () => db.close() };
};
