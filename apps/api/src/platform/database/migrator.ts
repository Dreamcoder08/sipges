import { readdir, readFile } from 'node:fs/promises';
import type { SqlClient } from './sql-client.ts';

export type Migration = { readonly version: string; readonly sql: string };

/** Arbitrary constant shared by every MASCLI instance for pg_advisory_xact_lock. */
const MIGRATION_LOCK_KEY = 7_361_524_002;

/** Loads `NNNN_name.sql` files bundled with the API, sorted by version. */
export const loadMigrations = async (): Promise<Migration[]> => {
  // Resolved on call, not on import: runtimes without a file system never evaluate it.
  const migrationsDir = new URL('./migrations/', import.meta.url);
  const files = (await readdir(migrationsDir))
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  return Promise.all(
    files.map(async (file) => ({
      version: file.replace(/\.sql$/, ''),
      sql: await readFile(new URL(file, migrationsDir), 'utf8'),
    })),
  );
};

/**
 * Versions in `migrations` not yet recorded in `schema_migrations`, read-only: no lock, no DDL.
 * A database that was never migrated (no table) has every migration pending.
 */
export const pendingMigrations = async (
  client: SqlClient,
  migrations: readonly Migration[],
): Promise<string[]> => {
  const [{ present } = { present: false }] = await client.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );
  if (!present) return migrations.map((m) => m.version);
  const done = new Set(
    (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).map(
      (r) => r.version,
    ),
  );
  return migrations.map((m) => m.version).filter((v) => !done.has(v));
};

/** Applies pending migrations, each in its own transaction. Returns the applied versions. */
export const migrate = async (
  client: SqlClient,
  migrations: readonly Migration[],
): Promise<string[]> => {
  const versions = migrations.map((m) => m.version);
  if (versions.some((v, i) => i > 0 && v <= (versions[i - 1] ?? ''))) {
    throw new Error('Migrations must be sorted by version');
  }

  // CREATE TABLE IF NOT EXISTS is not race-free across connections; serialize it as well.
  await client.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await tx.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
  });
  const done = new Set(
    (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).map(
      (r) => r.version,
    ),
  );

  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    let ran = false;
    try {
      await client.transaction(async (tx) => {
        // Another instance may be migrating concurrently: serialize, then re-check.
        await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
        const existing = await tx.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
          migration.version,
        ]);
        if (existing.length > 0) return;
        await tx.exec(migration.sql);
        await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
        ran = true;
      });
    } catch (cause) {
      throw new Error(`Migration ${migration.version} failed`, { cause });
    }
    if (ran) applied.push(migration.version);
  }
  return applied;
};
