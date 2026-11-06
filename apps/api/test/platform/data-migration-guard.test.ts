import { describe, expect, it } from 'vitest';
import { loadMigrations } from '../../src/platform/database/migrator.ts';
import { needsForceLifted } from '../support/data-migration-guard.ts';

/** Applied before the guard: they run on an owner with BYPASSRLS, or on an empty database. */
const LAST_UNGUARDED = '0032_rename_admin_username';

describe('needsForceLifted', () => {
  it('flags a rewrite of rows that leaves FORCE in place', () => {
    expect(needsForceLifted("UPDATE module_records SET payload = '{}';")).toBe(true);
    expect(needsForceLifted('DELETE FROM audit WHERE id < 10;')).toBe(true);
    expect(needsForceLifted('INSERT INTO audit (id) SELECT id FROM module_records;')).toBe(true);
  });

  it('accepts a rewrite that lifts FORCE', () => {
    expect(
      needsForceLifted(`ALTER TABLE module_records NO FORCE ROW LEVEL SECURITY;
        UPDATE module_records SET payload = '{}';
        ALTER TABLE module_records FORCE ROW LEVEL SECURITY;`),
    ).toBe(false);
  });

  it('ignores structure, comments and quoted text', () => {
    expect(needsForceLifted('CREATE TABLE t (id int); ALTER TABLE t ADD COLUMN x int;')).toBe(
      false,
    );
    expect(needsForceLifted('-- UPDATE module_records SET x = 1\nSELECT 1;')).toBe(false);
    expect(needsForceLifted("SELECT 'DELETE FROM audit';")).toBe(false);
  });
});

describe('migrations after the guard', () => {
  it('lift FORCE before rewriting rows', async () => {
    const migrations = await loadMigrations();
    const flagged = migrations
      .filter((m) => m.version > LAST_UNGUARDED && needsForceLifted(m.sql))
      .map((m) => m.version);
    expect(flagged).toEqual([]);
  });
});
