import { expect, it } from 'vitest';
import { createTestApp } from '../support/test-app.ts';

it('keeps the migrated schema free of custom types and extensions', async () => {
  // postgres.ts turns off fetch_types: postgres.js then knows only built-in types. An enum,
  // domain, range or extension type would come back undecoded (arrays as raw strings). If this
  // fails, either avoid the type or turn fetch_types back on (one more round trip per request).
  const t = await createTestApp();
  const types = await t.sql.query<{ name: string }>(
    `SELECT n.nspname || '.' || t.typname AS name
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND (t.typtype IN ('e', 'd', 'r', 'm')
             OR (t.typtype = 'c' AND NOT EXISTS (
                   SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind IN ('r', 'v', 'm', 'p', 'f'))))`,
  );
  const extensions = await t.sql.query<{ name: string }>(
    "SELECT extname AS name FROM pg_extension WHERE extname <> 'plpgsql'",
  );
  expect(types).toEqual([]);
  expect(extensions).toEqual([]);
});
