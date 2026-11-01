// Applies the API's SQL migrations to the production database. Run by the deploy workflow
// before `wrangler deploy`; the Worker only checks that nothing is pending (see src/index.ts).
// Needs SIPGES_MIGRATION_DATABASE_URL: the direct (not Hyperdrive) URL with sslmode=require.
// Node must run TypeScript natively (22.18+), like the API's own scripts.
import { loadMigrations, migrate } from '../api/src/platform/database/migrator.ts';
import { postgresClient } from '../api/src/platform/database/postgres.ts';

const url = process.env.SIPGES_MIGRATION_DATABASE_URL;
if (!url) {
  console.error('SIPGES_MIGRATION_DATABASE_URL is required');
  process.exit(1);
}

// The same SQL files src/migrations.ts bundles into the Worker (test/migrations.test.ts keeps
// both in step); Node reads them from disk because it cannot import `.sql` modules.
const migrations = await loadMigrations();
const database = postgresClient(url, { max: 1 });
let failed = false;
try {
  const applied = await migrate(database.client, migrations);
  console.log(
    applied.length > 0
      ? `Applied ${applied.length} migration(s): ${applied.join(', ')}`
      : `Database up to date (${migrations.length} migrations known)`,
  );
} catch (error) {
  failed = true;
  // Never print the URL: only the migration failure message and its class.
  console.error(error instanceof Error ? error.message : 'Migration failed');
  if (error instanceof Error && error.cause instanceof Error) {
    console.error(`Cause: ${error.cause.name}`);
  }
} finally {
  await database.close();
}
process.exit(failed ? 1 : 0);
