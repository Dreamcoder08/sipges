/**
 * Differential harness for the Rust operator tools (T43): runs the TypeScript tool and its Rust
 * port on two copies of the same synthetic database and compares exit code, stdout, stderr and
 * the tables each tool writes. Synthetic data only.
 *
 * SIPGES_TOOLS_DATABASE_URL names a throwaway PostgreSQL server reachable on a local host
 * (localhost, 127.0.0.1 or [::1]); the harness refuses any other host, so it can never point at
 * a real database. Each scenario creates and drops its own `sipges_tooldiff_*` databases there.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadMigrations, migrate } from '../../apps/api/src/platform/database/migrator.ts';
import { postgresClient } from '../../apps/api/src/platform/database/postgres.ts';
import type { SqlClient } from '../../apps/api/src/platform/database/sql-client.ts';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER = process.env.SIPGES_TOOLS_DATABASE_URL ?? '';
const RUST_DIR = process.env.SIPGES_RUST_TOOLS_DIR ?? `${ROOT}engines/target/debug`;
/** A fixed synthetic key: the tools only check it is present and well formed. */
export const SYNTHETIC_DATA_KEY = Buffer.alloc(32, 7).toString('base64');

if (!/^postgres(ql)?:\/\/[^@/]*@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(SERVER)) {
  console.error('SIPGES_TOOLS_DATABASE_URL must name a local synthetic PostgreSQL server.');
  process.exit(2);
}

const withDatabase = (name: string) => {
  const url = new URL(SERVER);
  url.pathname = `/${name}`;
  return url.toString();
};

export type Run = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

export type Side = {
  readonly url: string;
  readonly sql: SqlClient;
  readonly close: () => Promise<void>;
};

/** Creates a migrated database; `seed` fills it. */
const createSide = async (label: string, seed: (sql: SqlClient) => Promise<void>): Promise<Side> => {
  const name = `sipges_tooldiff_${randomBytes(4).toString('hex')}_${label}`;
  const admin = postgresClient(SERVER, { max: 1 });
  await admin.client.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const url = withDatabase(name);
  const { client, close } = postgresClient(url, { max: 2 });
  await migrate(client, await loadMigrations());
  await seed(client);
  return {
    url,
    sql: client,
    close: async () => {
      await close();
      const drop = postgresClient(SERVER, { max: 1 });
      await drop.client.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await drop.close();
    },
  };
};

const spawn = (command: string, args: readonly string[], env: Record<string, string>): Run => {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
    timeout: 300_000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

export type Tool = {
  /** TypeScript CLI, relative to the repository root. */
  readonly ts: string;
  /** Rust binary name in the target directory. */
  readonly rust: string;
};

export const runTs = (tool: Tool, args: readonly string[], env: Record<string, string>) =>
  spawn(process.execPath, [`${ROOT}${tool.ts}`, ...args], env);

export const runRust = (tool: Tool, args: readonly string[], env: Record<string, string>) =>
  spawn(`${RUST_DIR}/${tool.rust}`, args, env);

/** One step: the same arguments to both tools, each against its own database. */
export type Step = {
  readonly args: readonly string[];
  /**
   * Extra environment (the database URL and data key are set by the harness); a function gives
   * each tool its own values, for example its own object storage directory.
   */
  readonly env?: Record<string, string> | ((tool: 'ts' | 'rs') => Record<string, string>);
  /** Replaces run-dependent text in stdout, stderr and written files before comparing. */
  readonly normalize?: (text: string) => string;
  /**
   * Skip stderr: errors the TypeScript CLI does not catch print Node's stack trace (file paths,
   * line numbers), which a binary cannot reproduce; exit code and stdout are still compared.
   */
  readonly uncaught?: boolean;
  /** Text both tools must print on stderr, for steps whose stderr is not compared. */
  readonly stderrIncludes?: string;
  /** Files (relative to the repository root) each tool may write; compared, then deleted. */
  readonly files?: readonly string[];
  /** Runs on both databases right before this step. */
  readonly before?: (sql: SqlClient, tool: 'ts' | 'rs') => Promise<void>;
};

export type Scenario = {
  readonly name: string;
  readonly seed: (sql: SqlClient) => Promise<void>;
  readonly steps: readonly Step[];
  /**
   * Tables to compare after every step: SQL returning rows in a stable order, or a function for
   * values that must be computed (for example decrypted) before comparing.
   */
  readonly dumps: Readonly<
    Record<string, string | ((sql: SqlClient, tool: 'ts' | 'rs') => Promise<unknown>)>
  >;
  /** Runs on both sides between seeding and the first step (for example a failure trigger). */
  readonly prepare?: (sql: SqlClient) => Promise<void>;
};

const show = (value: unknown) => JSON.stringify(value, null, 1);

/** Runs every scenario; returns the number of differences. */
export const runScenarios = async (tool: Tool, scenarios: readonly Scenario[]): Promise<number> => {
  let differences = 0;
  let compared = 0;
  for (const scenario of scenarios) {
    const ts = await createSide('ts', scenario.seed);
    const rust = await createSide('rs', scenario.seed);
    try {
      await scenario.prepare?.(ts.sql);
      await scenario.prepare?.(rust.sql);
      for (const [index, step] of scenario.steps.entries()) {
        const label = `${scenario.name} #${index + 1} (${step.args.join(' ') || 'no args'})`;
        const env = (side: Side, tool: 'ts' | 'rs'): Record<string, string> => ({
          SIPGES_DATA_KEY: SYNTHETIC_DATA_KEY,
          SIPGES_DATABASE_URL: side.url,
          ...(typeof step.env === 'function' ? step.env(tool) : step.env),
        });
        const normalize = step.normalize ?? ((text: string) => text);
        const takeFiles = () =>
          (step.files ?? []).map((file) => {
            const path = `${ROOT}${file}`;
            if (!existsSync(path)) return null;
            const text = readFileSync(path, 'utf8');
            rmSync(path);
            return normalize(text);
          });
        await step.before?.(ts.sql, 'ts');
        await step.before?.(rust.sql, 'rs');
        const a = runTs(tool, step.args, env(ts, 'ts'));
        const aFiles = takeFiles();
        const b = runRust(tool, step.args, env(rust, 'rs'));
        const bFiles = takeFiles();
        const outputs: [string, unknown, unknown][] = [
          ['exit code', a.code, b.code],
          ['stdout', normalize(a.stdout), normalize(b.stdout)],
          ['files', aFiles, bFiles],
        ];
        if (!step.uncaught) outputs.push(['stderr', normalize(a.stderr), normalize(b.stderr)]);
        else if (!a.stderr || !normalize(b.stderr)) outputs.push(['stderr present', !!a.stderr, !!b.stderr]);
        if (step.stderrIncludes !== undefined)
          outputs.push([
            `stderr names "${step.stderrIncludes}"`,
            a.stderr.includes(step.stderrIncludes),
            b.stderr.includes(step.stderrIncludes) ? a.stderr.includes(step.stderrIncludes) : 'missing',
          ]);
        const dump = (
          sql: SqlClient,
          query: string | ((sql: SqlClient, tool: 'ts' | 'rs') => Promise<unknown>),
          tool: 'ts' | 'rs',
        ) => (typeof query === 'string' ? sql.query(query) : query(sql, tool));
        for (const [table, query] of Object.entries(scenario.dumps))
          outputs.push([
            `table ${table}`,
            await dump(ts.sql, query, 'ts'),
            await dump(rust.sql, query, 'rs'),
          ]);
        for (const [what, left, right] of outputs) {
          compared++;
          if (show(left) === show(right)) continue;
          differences++;
          console.error(`DIFF ${label}: ${what}\n  TypeScript: ${show(left)}\n  Rust:       ${show(right)}`);
        }
        console.info(`ok? ${label}: exit ${a.code}/${b.code}`);
      }
    } finally {
      await ts.close();
      await rust.close();
    }
  }
  console.info(`${compared} comparisons, ${differences} differences`);
  return differences;
};
