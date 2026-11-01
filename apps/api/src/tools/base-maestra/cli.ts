/**
 * `pnpm --filter @sipges/api import:base-maestra -- --seed <file> [--scope C/P] [--apply]`
 * Loads the prototype's Base Maestra (seed.json) into one tenant. Dry run unless --apply.
 * Output holds module names, counts and positions only — never record values.
 * Runbook: docs/migration/base-maestra.md.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { createSqlRecordStore } from '../../contexts/records/infrastructure/sql-record-store.ts';
import { loadConfig } from '../../platform/config.ts';
import { loadMigrations, migrate } from '../../platform/database/migrator.ts';
import { pgliteClient } from '../../platform/database/pglite.ts';
import { postgresClient } from '../../platform/database/postgres.ts';
import { importBaseMaestra } from './run.ts';

const USAGE = `Usage: node src/tools/base-maestra/cli.ts --seed <file> [--scope SIPGES/PRJ-SECHURA] [--apply]
Target database: SIPGES_DATABASE_URL or SIPGES_PGLITE_DIR (the API configuration).`;

export const main = async (argv: readonly string[]) => {
  const { values } = parseArgs({
    args: [...argv].filter((arg) => arg !== '--'),
    options: {
      seed: { type: 'string' },
      scope: { type: 'string', default: 'SIPGES/PRJ-SECHURA' },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help || !values.seed || !/^[^/]+\/[^/]+$/.test(values.scope)) {
    console.info(USAGE);
    return values.help ? 0 : 2;
  }
  const seed: unknown = JSON.parse(await readFile(values.seed, 'utf8'));
  const config = loadConfig(process.env);
  let sql;
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
    const [tenant] = await sql.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM tenants WHERE tenant_id = $1',
      [values.scope],
    );
    if (!tenant) {
      console.error(`El proyecto ${values.scope} no existe; inícielo desde la aplicación primero.`);
      return 1;
    }
    const report = await importBaseMaestra(createSqlRecordStore(sql), values.scope, seed, {
      apply: values.apply,
      source: path.basename(values.seed),
      now: () => new Date(),
    });
    console.info(JSON.stringify(report, null, 2));
    if (!values.apply) console.info('Simulación: no se escribió nada. Use --apply para importar.');
    return report.problems.length ? 1 : 0;
  } finally {
    await close();
  }
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      // Parser and driver errors can echo values or connection details; report the class only.
      console.error(
        'Importación de Base Maestra fallida:',
        error instanceof Error ? error.name : 'unknown',
      );
      process.exitCode = 1;
    },
  );
}
