/**
 * `pnpm --filter @sipges/api review:materialize -- [--scope C/P] [--apply]`
 * Creates the records of document review items approved before approvals created them.
 * Dry run unless --apply. Output holds tenant ids, module names and counts only.
 * Runbook: docs/operations/review-materialize.md (production only with the owner's word).
 */
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { loadConfig } from '../../platform/config.ts';
import { loadMigrations, migrate } from '../../platform/database/migrator.ts';
import { pgliteClient } from '../../platform/database/pglite.ts';
import { postgresClient } from '../../platform/database/postgres.ts';
import type { SqlClient } from '../../platform/database/sql-client.ts';
import { runReviewMaterialize } from './run.ts';

const USAGE = `Usage: node src/tools/review-materialize/cli.ts [--scope SIPGES/PRJ-SECHURA] [--apply]
Target database: SIPGES_DATABASE_URL or SIPGES_PGLITE_DIR (the API configuration).`;

export const main = async (argv: readonly string[]) => {
  const { values } = parseArgs({
    args: [...argv].filter((arg) => arg !== '--'),
    options: {
      scope: { type: 'string' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help || (values.scope !== undefined && !/^[^/]+\/[^/]+$/.test(values.scope))) {
    console.info(USAGE);
    return values.help ? 0 : 2;
  }
  const config = loadConfig(process.env);
  let sql: SqlClient;
  let close: () => Promise<void>;
  if (config.databaseUrl) {
    const client = postgresClient(config.databaseUrl);
    sql = client.client;
    close = client.close;
  } else {
    await mkdir(config.pgliteDir, { recursive: true });
    const db = new PGlite(config.pgliteDir);
    sql = pgliteClient(db);
    close = () => db.close();
  }
  try {
    await migrate(sql, await loadMigrations());
    const run = await runReviewMaterialize(sql, {
      apply: values.apply,
      ...(values.scope ? { scope: values.scope } : {}),
      now: () => new Date(),
    });
    if (run.missing.length) {
      console.error(`El proyecto ${run.missing.join(', ')} no existe.`);
      return 1;
    }
    console.info(JSON.stringify(run, null, 2));
    if (!values.apply) console.info('Simulación: no se escribió nada. Use --apply para crear.');
    return run.tenants.some((tenant) => tenant.problems.length) ? 1 : 0;
  } finally {
    await close();
  }
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      // Driver errors can echo values or connection details; report the class only.
      console.error(
        'Creación de registros de revisión fallida:',
        error instanceof Error ? error.name : 'unknown',
      );
      process.exitCode = 1;
    },
  );
}
