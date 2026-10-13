import { PGlite } from '@electric-sql/pglite';
import { trackTestDatabase } from '../support/test-database.ts';
import { describe, expect, it } from 'vitest';
import { pgliteClient } from '../../src/platform/database/pglite.ts';
import { loadMigrations, migrate } from '../../src/platform/database/migrator.ts';

const first = { version: '0001_first', sql: 'CREATE TABLE first (id int PRIMARY KEY);' };
const second = { version: '0002_second', sql: 'CREATE TABLE second (id int PRIMARY KEY);' };
const migrations = [first, second];

const tables = async (db: PGlite) =>
  (
    await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    )
  ).rows.map((r) => r.table_name);

describe('migrate', () => {
  it('applies pending migrations in order and records them', async () => {
    const db = trackTestDatabase(new PGlite());
    const applied = await migrate(pgliteClient(db), migrations);
    expect(applied).toEqual(['0001_first', '0002_second']);
    expect(await tables(db)).toEqual(['first', 'schema_migrations', 'second']);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const db = trackTestDatabase(new PGlite());
    await migrate(pgliteClient(db), migrations);
    expect(await migrate(pgliteClient(db), migrations)).toEqual([]);
  });

  it('rolls back a failing migration and leaves earlier ones applied', async () => {
    const db = trackTestDatabase(new PGlite());
    const broken = [
      first,
      { version: '0002_broken', sql: 'CREATE TABLE half (id int); SELECT * FROM missing_table;' },
    ];
    await expect(migrate(pgliteClient(db), broken)).rejects.toThrow(/0002_broken/);
    expect(await tables(db)).toEqual(['first', 'schema_migrations']);
    const versions = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
    expect(versions.rows.map((r) => r.version)).toEqual(['0001_first']);
  });

  it('rejects migrations that are out of order', async () => {
    const db = trackTestDatabase(new PGlite());
    await expect(migrate(pgliteClient(db), [second, first])).rejects.toThrow(
      'Migrations must be sorted by version',
    );
  });
});

describe('loadMigrations', () => {
  it('loads the bundled SQL files sorted by version', async () => {
    const loaded = await loadMigrations();
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.map((m) => m.version)).toEqual([...loaded.map((m) => m.version)].sort());
    expect(loaded[0]?.version).toBe('0001_identity');
  });
});

describe('migrate under concurrency', () => {
  it('applies each migration once when two runners start together', async () => {
    const db = trackTestDatabase(new PGlite());
    const client = pgliteClient(db);
    const [a, b] = await Promise.all([migrate(client, migrations), migrate(client, migrations)]);
    expect([...a, ...b].sort()).toEqual(['0001_first', '0002_second']);
    const versions = await db.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY 1',
    );
    expect(versions.rows.map((r) => r.version)).toEqual(['0001_first', '0002_second']);
  });
});
