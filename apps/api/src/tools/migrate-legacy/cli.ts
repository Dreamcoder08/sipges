/**
 * `pnpm --filter @sipges/api migrate:legacy` — SQLite → PostgreSQL migration CLI.
 * Runbook: docs/migration/data-migration.md. The legacy installation is only ever read.
 *
 * Output is a summary plus an optional JSON report; both contain counts, problem codes and
 * identifiers only — never record contents, password hashes or TOTP secrets.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { moduleForSlug } from '../../contexts/records/application/index.ts';
import { createObjectStorage } from '../../contexts/evidence/infrastructure/index.ts';
import { createSecretCipher } from '../../contexts/identity/infrastructure/secret-cipher.ts';
import { loadConfig } from '../../platform/config.ts';
import { loadMigrations, migrate, pendingMigrations } from '../../platform/database/migrator.ts';
import { pgliteClient } from '../../platform/database/pglite.ts';
import { postgresClient } from '../../platform/database/postgres.ts';
import type { SqlClient } from '../../platform/database/sql-client.ts';
import { type MigrationMode, reportJson, runMigration, summarize } from './application/migrate.ts';
import { createSqlTargetStore } from './infrastructure/sql-target-store.ts';
import { createSqliteLegacySource, legacyLayout } from './infrastructure/sqlite-legacy-source.ts';

const USAGE = `Usage: node src/tools/migrate-legacy/cli.ts --legacy-root <dir> [options]

Modes (default: dry-run)
  --dry-run                Read and report only; nothing is written, schema migrations included.
  --apply                  Write into PostgreSQL (one transaction per tenant).
  --verify                 Compare source and target counts, checksums and attachment bytes.

Options
  --legacy-root <dir>      Legacy SIPGES checkout (expects <dir>/data/...).
  --auth-db <file>         Override auth_global.db (SIPGES_AUTH_DB_PATH).
  --default-db <file>      Override the default tenant database (SIPGES_DB_PATH).
  --tenant-dir <dir>       Override the tenant directory (SIPGES_TENANT_DIR).
  --upload-dir <dir>       Override the upload root (SIPGES_UPLOAD_DIR).
  --config-dir <dir>       Override the JSON configuration directory (<root>/data).
  --only <company/project> Restrict the run to one scope (repeatable).
  --allow-non-empty        Write even though the target already holds data.
  --report <file>          Write the JSON report to this path.
  --help                   Show this message.

Environment: the target database, data key and object storage come from the API configuration
(SIPGES_DATABASE_URL or SIPGES_PGLITE_DIR, SIPGES_DATA_KEY, SIPGES_STORAGE...).`;

const Options = z
  .object({
    'legacy-root': z.string().min(1).optional(),
    'auth-db': z.string().min(1).optional(),
    'default-db': z.string().min(1).optional(),
    'tenant-dir': z.string().min(1).optional(),
    'upload-dir': z.string().min(1).optional(),
    'config-dir': z.string().min(1).optional(),
    only: z.array(z.string().regex(/^[^/]+\/[^/]+$/, 'Use company/project')).default([]),
    report: z.string().min(1).optional(),
    'allow-non-empty': z.boolean().default(false),
    apply: z.boolean().default(false),
    verify: z.boolean().default(false),
    'dry-run': z.boolean().default(false),
    help: z.boolean().default(false),
  })
  .strict();

export const parseCliArgs = (argv: readonly string[]) => {
  const { values } = parseArgs({
    // pnpm forwards the `--` of `pnpm --filter … migrate:legacy -- <flags>`.
    args: argv.filter((arg) => arg !== '--'),
    options: {
      'legacy-root': { type: 'string' },
      'auth-db': { type: 'string' },
      'default-db': { type: 'string' },
      'tenant-dir': { type: 'string' },
      'upload-dir': { type: 'string' },
      'config-dir': { type: 'string' },
      only: { type: 'string', multiple: true },
      report: { type: 'string' },
      'allow-non-empty': { type: 'boolean' },
      apply: { type: 'boolean' },
      verify: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
    strict: true,
  });
  const parsed = Options.parse(values);
  if (parsed.apply && parsed.verify) throw new Error('Choose either --apply or --verify');
  if (parsed.apply && parsed['dry-run']) throw new Error('Choose either --dry-run or --apply');
  const mode: MigrationMode = parsed.apply ? 'apply' : parsed.verify ? 'verify' : 'dry-run';
  return { ...parsed, mode };
};

const openDatabase = async (
  databaseUrl: string | undefined,
  pgliteDir: string,
): Promise<{ sql: SqlClient; close: () => Promise<void> }> => {
  if (databaseUrl) {
    const { client, close } = postgresClient(databaseUrl);
    return { sql: client, close };
  }
  await mkdir(pgliteDir, { recursive: true });
  const db = new PGlite(pgliteDir);
  return { sql: pgliteClient(db), close: () => db.close() };
};

export const main = async (argv: readonly string[]): Promise<number> => {
  const options = parseCliArgs(argv);
  if (options.help || !options['legacy-root']) {
    console.info(USAGE);
    return options.help ? 0 : 2;
  }

  const config = loadConfig(process.env);
  const layout = legacyLayout(options['legacy-root'], {
    ...(options['auth-db'] ? { authDb: options['auth-db'] } : {}),
    ...(options['default-db'] ? { defaultDb: options['default-db'] } : {}),
    ...(options['tenant-dir'] ? { tenantDir: options['tenant-dir'] } : {}),
    ...(options['upload-dir'] ? { uploadDir: options['upload-dir'] } : {}),
    ...(options['config-dir'] ? { configDir: options['config-dir'] } : {}),
  });

  const source = createSqliteLegacySource(layout);
  const database = await openDatabase(config.databaseUrl, config.pgliteDir);
  try {
    const migrations = await loadMigrations();
    // A dry run writes nothing, so it leaves pending migrations for --apply and reports them.
    const dryRun = options.mode === 'dry-run';
    const targetMigrationsPending = dryRun
      ? (await pendingMigrations(database.sql, migrations)).length
      : 0;
    if (!dryRun) await migrate(database.sql, migrations);
    const report = await runMigration(
      {
        source,
        target: createSqlTargetStore(database.sql, createSecretCipher(config.dataKey)),
        storage: createObjectStorage(config.storage),
        moduleForSlug,
        now: () => new Date(),
      },
      {
        mode: options.mode,
        allowNonEmptyTarget: options['allow-non-empty'],
        only: options.only,
        targetMigrationsPending,
      },
    );
    console.info(summarize(report));
    if (options.report) await writeFile(options.report, `${reportJson(report)}\n`, 'utf8');
    return report.ok ? 0 : 1;
  } finally {
    source.close();
    await database.close();
  }
};

// Run only as a program, never on import (tests import `main` and `parseCliArgs`).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
