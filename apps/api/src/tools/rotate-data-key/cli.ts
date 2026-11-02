/**
 * `pnpm --filter @sipges/api rotate:data-key` — re-encrypts sealed secrets with a new
 * SIPGES_DATA_KEY. Procedure: docs/operations/data-key-rotation.md.
 *
 * Keys come only from the environment (never arguments: they would land in shell history and
 * process lists). Output holds counts and row identifiers, never plaintext or keys.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../platform/config.ts';
import { openDatabase } from '../../platform/database/open.ts';
import { rotateDataKey, summarize } from './rotate.ts';

const USAGE = `Usage: node src/tools/rotate-data-key/cli.ts [--dry-run | --apply] [--report <file>]

Modes (default: dry-run)
  --dry-run          Count values per table and column; nothing is written.
  --apply            Re-encrypt stale values (one transaction per table or tenant).

Options
  --report <file>    Also write the JSON report (counts and row identifiers only).
  --help             Show this message.

Environment
  SIPGES_DATA_KEY           The NEW key (base64, 32 bytes).
  SIPGES_DATA_KEY_PREVIOUS  The OLD key being rotated out.
  SIPGES_DATABASE_URL       Target PostgreSQL (or SIPGES_PGLITE_DIR for a local copy).`;

export const parseCliArgs = (argv: readonly string[]) => {
  const { values } = parseArgs({
    // pnpm forwards the `--` of `pnpm … rotate:data-key -- --apply` to the script.
    args: argv[0] === '--' ? argv.slice(1) : [...argv],
    options: {
      apply: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      report: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.apply && values['dry-run']) throw new Error('Choose either --apply or --dry-run');
  return {
    mode: values.apply ? ('apply' as const) : ('dry-run' as const),
    report: values.report,
    help: values.help,
  };
};

export const main = async (argv: readonly string[], env = process.env): Promise<number> => {
  const options = parseCliArgs(argv);
  if (options.help) {
    console.info(USAGE);
    return 0;
  }
  const config = loadConfig(env);
  if (!config.dataKeyPrevious) {
    console.error('SIPGES_DATA_KEY_PREVIOUS (the old key) is required.\n');
    console.info(USAGE);
    return 2;
  }
  const database = await openDatabase(config);
  try {
    const report = await rotateDataKey(database.sql, {
      oldKey: config.dataKeyPrevious,
      newKey: config.dataKey,
      mode: options.mode,
    });
    console.info(summarize(report));
    if (options.report) {
      await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    return report.ok ? 0 : 1;
  } catch (error) {
    // Messages are this tool's own (table and column names); a failed unit was rolled back.
    console.error(`Rotation stopped: ${error instanceof Error ? error.message : String(error)}`);
    console.error('That unit was rolled back; earlier units may be committed. Re-run to resume.');
    return 1;
  } finally {
    await database.close();
  }
};

// Run only as a program, never on import (tests import `main` and `parseCliArgs`).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
