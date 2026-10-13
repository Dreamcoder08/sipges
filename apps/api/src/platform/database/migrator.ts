import { readdir, readFile } from 'node:fs/promises';
import type { SqlClient } from './sql-client.ts';

export type Migration = { readonly version: string; readonly sql: string };

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

/** Loads `NNNN_name.sql` files bundled with the API, sorted by version. */
export const loadMigrations = async (): Promise<Migration[]> => {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  return Promise.all(
    files.map(async (file) => ({
      version: file.replace(/\.sql$/, ''),
      sql: await readFile(new URL(file, MIGRATIONS_DIR), 'utf8'),
    })),
  );
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

  await client.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = new Set(
    (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).map(
      (r) => r.version,
    ),
  );

  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    try {
      await client.transaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version]);
      });
    } catch (cause) {
      throw new Error(`Migration ${migration.version} failed`, { cause });
    }
    applied.push(migration.version);
  }
  return applied;
};
