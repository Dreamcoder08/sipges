// One-time move of a desktop install's PGlite database into a native PostgreSQL 18 server, for
// the Go API (docs/adr/0036 §4). It reads a COPY of the state folder, never the original, and
// never opens even the copy: its pglite folder is copied to a scratch folder, only that is opened
// (PGlite writes to what it opens) and it is removed at the end. The copy is dumped logically
// with the pinned pglite-tools pgDump (plain SQL, --inserts, --no-owner) and restored into the
// target in ONE transaction, which also compares source and target table by table with
// tables.mjs, plus functions, views, indexes, triggers, policies and grants. Any difference rolls
// the transaction back: the target is left empty. The copy's pglite folder is hashed before and
// after and must not change. Values are never printed: counts, names and keyed fingerprints only.
//
// Exit code 0: moved, no difference; 1: a difference (nothing committed); 2: refused or failed
// before anything was committed, with the reason. Read deploy/desktop/migration/README.md.
//
//   SIPGES_MOVE_DATABASE_URL=postgres://<login>@127.0.0.1:<port>/<database> \
//     node deploy/desktop/migration/pglite-to-postgres.mjs --state <copy of the state folder>
//     [--to <url>] [--scratch <folder>]
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { cp, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { parseArgs } from 'node:util';
import {
  NOT_COMPARED_EXIT,
  Refusal,
  compareDatabases,
  readDatabase,
  safeReason,
  treeDigest,
  verdict,
} from './tables.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const API_PACKAGE = path.join(here, '../../../apps/api/package.json');
const PGLITE = '@electric-sql/pglite';
const TOOLS = '@electric-sql/pglite-tools';
// pg_dump's own arguments; pgDump adds -U postgres --inserts -j 1 -f <file>. No owner: the
// tables must belong to the target login, the one the Go API serves with. Grants are kept.
const DUMP_ARGS = ['--no-owner'];
// Session settings both sides are read with, so every value prints the same text.
const SESSION = { TimeZone: 'UTC', DateStyle: 'ISO, MDY', IntervalStyle: 'postgres' };
const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;
const NOT_EXTENSION = (oid) =>
  `NOT EXISTS (SELECT FROM pg_depend d WHERE d.objid = ${oid} AND d.deptype = 'e')`;

const refuse = (message) => {
  throw new Refusal(message);
};
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * The original state folder of the desktop install, which this tool never reads: the Windows
 * installer's %LOCALAPPDATA%\SIPGES, Linux's ~/.local/share/sipges-local (install.sh).
 */
export function originalState(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'win32')
    return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'SIPGES');
  return path.posix.join(env.HOME || home, '.local', 'share', 'sipges-local');
}

/** Every table of either side compared as identical: a move adds, drops and changes nothing. */
export function strictRules(...sides) {
  const rules = Object.create(null);
  for (const side of sides)
    for (const name of Object.keys(side))
      rules[name] = { kind: 'identical', why: 'a move changes no row' };
  return rules;
}

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const within = (parent, child) => {
  const r = path.relative(fold(parent), fold(child));
  return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r));
};

/**
 * The rule of install.sh and install.ps1 for the copy given to the data move: the path itself
 * (resolved as update.mjs does, so no spelling gets past it) must not be a link or junction, and
 * its real folder must not be the original or inside it. Its pglite folder must be a plain folder
 * too. Returns the pglite folder.
 */
export async function checkCopy(given, original = originalState()) {
  const resolved = path.resolve(given);
  const info = await lstat(resolved).catch(() => refuse(`--state ${given} does not exist`));
  if (info.isSymbolicLink())
    refuse(
      `--state ${given} is a link or junction: pass the real folder of the copy, never a link to it`,
    );
  if (!info.isDirectory()) refuse(`--state ${given} is not a folder`);
  const real = await realpath(resolved);
  const originalReal = await realpath(original).catch(() => path.resolve(original));
  if (within(originalReal, real))
    refuse(
      `--state ${given} is the original state folder ${original} or inside it: copy it first and pass the copy`,
    );
  const db = path.join(real, 'pglite');
  const dbInfo = await lstat(db).catch(() => null);
  if (dbInfo?.isSymbolicLink())
    refuse(`--state ${given} holds pglite as a link or junction: pass a plain copy`);
  if (!dbInfo?.isDirectory() || !(await lstat(path.join(db, 'PG_VERSION')).catch(() => null)))
    refuse(`--state ${given} is not a SIPGES state folder (no pglite database)`);
  if (within(originalReal, await realpath(db)))
    refuse(`--state ${given} leads to the original state folder ${original}: pass a plain copy`);
  return db;
}

/** A postgres:// URL to 127.0.0.1 only; never printed, it may hold a password. */
export function checkTarget(url) {
  let parsed;
  try {
    parsed = new URL(url ?? '');
  } catch {
    return refuse('the target must be a postgres:// URL to 127.0.0.1 (--to or SIPGES_MOVE_DATABASE_URL)');
  }
  const local =
    ['postgres:', 'postgresql:'].includes(parsed.protocol) &&
    parsed.hostname === '127.0.0.1' &&
    !parsed.searchParams.has('host') &&
    !parsed.searchParams.has('hostaddr') &&
    parsed.pathname.length > 1;
  if (!local)
    refuse('the target must be a postgres:// URL to a database on 127.0.0.1, with no host override');
  return parsed;
}

/** The directory of an installed package, found from its entry point. */
async function packageDir(require, name) {
  let dir = path.dirname(require.resolve(name));
  for (;;) {
    const manifest = await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => null);
    if (manifest && JSON.parse(manifest).name === name) return { dir, manifest: JSON.parse(manifest) };
    const up = path.dirname(dir);
    if (up === dir) return refuse(`${name} has no package.json`);
    dir = up;
  }
}

/** PGlite, pgDump and postgres.js from apps/api, refusing a PGlite the tools were not built for. */
export async function loadTools(from = API_PACKAGE) {
  const require = createRequire(from);
  const load = async (name, sub = '') => {
    try {
      return await import(pathToFileURL(require.resolve(`${name}${sub}`)).href);
    } catch {
      return refuse(`${name} is not installed in apps/api: run pnpm install in the checkout`);
    }
  };
  const [{ PGlite }, { pgDump }, { default: postgres }] = [
    await load(PGLITE),
    await load(TOOLS, '/pg_dump'),
    await load('postgres'),
  ];
  const pglite = (await packageDir(require, PGLITE)).manifest.version;
  const { manifest: tools } = await packageDir(require, TOOLS);
  const peer = tools.peerDependencies?.[PGLITE];
  if (pglite !== peer)
    refuse(`${TOOLS} needs ${PGLITE} ${peer} exactly, and ${pglite} is installed: pin the pair`);
  return { PGlite, pgDump, postgres, pglite, tools: tools.version };
}

/** readDatabase's driver interface over postgres.js. */
const driver = (sql) => ({
  query: async (text, params = [], options = {}) => {
    const q = sql.unsafe(text, params);
    return { rows: options.rowMode === 'array' ? await q.values() : await q };
  },
});

const pairs = async (db, sql) =>
  Object.fromEntries((await db.query(sql)).rows.map((r) => [r.k, r.v ?? '']));

/**
 * What readDatabase does not compare: functions, views, every index, trigger and policy
 * definitions, and grants (the table owner as OWNER, since the owner changes by design).
 * `{ name: digest }`, so no definition text is ever printed.
 */
export async function readCatalog(db) {
  const out = Object.create(null);
  const add = (label, map) => {
    for (const [k, v] of Object.entries(map)) out[`${label} ${k}`] = v;
  };
  add(
    'function',
    await pairs(
      db,
      `SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k,
         md5(pg_get_functiondef(p.oid)) AS v FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ${USER_SCHEMAS} AND p.prokind IN ('f', 'p') AND ${NOT_EXTENSION('p.oid')}`,
    ),
  );
  add(
    'view',
    await pairs(
      db,
      `SELECT n.nspname || '.' || c.relname AS k, md5(pg_get_viewdef(c.oid)) AS v FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMAS} AND c.relkind IN ('v', 'm')`,
    ),
  );
  add(
    'index',
    await pairs(
      db,
      `SELECT n.nspname || '.' || c.relname AS k, md5(pg_get_indexdef(i.indexrelid)) AS v
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMAS}`,
    ),
  );
  add(
    'trigger',
    await pairs(
      db,
      `SELECT c.relname || '.' || t.tgname AS k, md5(pg_get_triggerdef(t.oid)) AS v FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${USER_SCHEMAS} AND NOT t.tgisinternal`,
    ),
  );
  add(
    'policy',
    await pairs(
      db,
      `SELECT c.relname || '.' || p.polname AS k, md5(concat_ws('|', p.polcmd, p.polpermissive,
         (SELECT string_agg(r.name, ',' ORDER BY r.name) FROM (SELECT CASE WHEN x = 0 THEN 'PUBLIC'
           ELSE x::regrole::text END AS name FROM unnest(p.polroles) AS x) r),
         pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))) AS v
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid`,
    ),
  );
  add(
    'grant',
    await pairs(
      db,
      `WITH objects AS (
         SELECT 'relation ' || n.nspname || '.' || c.relname AS name, c.relacl AS acl, c.relowner AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE ${USER_SCHEMAS} AND c.relacl IS NOT NULL
         UNION ALL SELECT 'column ' || n.nspname || '.' || c.relname || '.' || a.attname, a.attacl, c.relowner
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMAS} AND a.attacl IS NOT NULL
         UNION ALL SELECT 'function ' || n.nspname || '.' || p.proname || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')', p.proacl, p.proowner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ${USER_SCHEMAS} AND p.proacl IS NOT NULL AND ${NOT_EXTENSION('p.oid')}
         UNION ALL SELECT 'schema ' || n.nspname, n.nspacl, n.nspowner FROM pg_namespace n
         WHERE ${USER_SCHEMAS} AND n.nspacl IS NOT NULL)
       SELECT o.name || ' to ' || CASE WHEN e.grantee = 0 THEN 'PUBLIC'
           WHEN e.grantee = o.owner THEN 'OWNER' ELSE e.grantee::regrole::text END
         || ' ' || e.privilege_type AS k, CASE WHEN e.is_grantable THEN 'grantable' ELSE '' END AS v
       FROM objects o, aclexplode(o.acl) e`,
    ),
  );
  return out;
}

/** Roles other than the owner and PUBLIC that grants or policies name, with whether the owner is a member. */
async function sourceRoles(db) {
  const { rows } = await db.query(
    `WITH named AS (
       SELECT e.grantee AS role FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
         aclexplode(c.relacl) e WHERE ${USER_SCHEMAS} AND e.grantee <> c.relowner
       UNION SELECT e.grantee FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(a.attacl) e WHERE ${USER_SCHEMAS}
       UNION SELECT e.grantee FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
         aclexplode(p.proacl) e WHERE ${USER_SCHEMAS}
       UNION SELECT e.grantee FROM pg_namespace n, aclexplode(n.nspacl) e
         WHERE ${USER_SCHEMAS} AND e.grantee <> n.nspowner
       UNION SELECT x FROM pg_policy p, unnest(p.polroles) x)
     SELECT r.rolname AS name, EXISTS (SELECT FROM pg_auth_members m WHERE m.roleid = r.oid
       AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS member
     FROM named JOIN pg_roles r ON r.oid = named.role
     WHERE named.role <> 0 AND r.rolname NOT LIKE 'pg\\_%' AND r.rolname <> current_user
     ORDER BY 1`,
  );
  return rows;
}

/** Copies the pglite folder to scratch, dumps and reads it there, and removes the copy. */
async function readSource(tools, db, scratchRoot) {
  const work = await mkdtemp(path.join(scratchRoot, 'sipges-pglite-move-'));
  SCRATCH.work = work;
  try {
    const dir = path.join(work, 'pglite');
    await cp(db, dir, { recursive: true });
    const pg = new tools.PGlite(dir);
    try {
      await pg.waitReady;
      const version = (await pg.query('SHOW server_version_num')).rows[0].server_version_num;
      const file = await tools.pgDump({ pg, args: DUMP_ARGS });
      const dump = await file.text();
      for (const [k, v] of Object.entries(SESSION)) await pg.exec(`SET ${k} = '${v}'`);
      const tables = await readDatabase(pg);
      const catalog = await readCatalog(pg);
      const roles = await sourceRoles(pg);
      return { version, dump, tables, catalog, roles };
    } finally {
      await pg.close().catch(() => {});
    }
  } finally {
    await rm(work, { recursive: true, force: true });
    SCRATCH.work = null;
  }
}

/** Refuses a login that would own tables the Go API cannot serve, or a server that is not 18. */
async function checkLogin(sql) {
  const [{ version }] = await sql`SELECT current_setting('server_version_num')::int AS version`;
  if (version < 180000 || version >= 190000)
    refuse(`the target server is PostgreSQL ${Math.floor(version / 10000)}; this move needs 18`);
  const [{ privileged }] = await sql`SELECT EXISTS (SELECT FROM pg_roles
    WHERE rolname IN (session_user, current_user) AND (rolsuper OR rolbypassrls)) AS privileged`;
  if (privileged)
    refuse(
      'the target login is a superuser or has BYPASSRLS: connect as the login the Go API serves with, so the tables belong to it and row-level security binds it',
    );
}

async function checkEmpty(tx) {
  const [{ n }] = await tx.unsafe(
    `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${USER_SCHEMAS})
     + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ${USER_SCHEMAS} AND ${NOT_EXTENSION('p.oid')})
     + (SELECT count(*) FROM pg_namespace n WHERE ${USER_SCHEMAS} AND n.nspname <> 'public')
     + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE ${USER_SCHEMAS} AND t.typtype IN ('e', 'd', 'c', 'r')
       AND NOT EXISTS (SELECT FROM pg_class c WHERE c.oid = t.typrelid)) AS n`,
  );
  if (Number(n) > 0)
    refuse(
      'the target database is not empty: the move only fills a new, empty database (nothing was written)',
    );
}

/** The roles the source grants to, created when missing and joined as the source owner was. */
async function prepareRoles(tx, roles) {
  for (const { name, member } of roles) {
    try {
      const [{ exists, joined }] = await tx`SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = ${name}) AS exists,
        EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
          WHERE r.rolname = ${name} AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS joined`;
      // As the migrations create it (0003, 0030): no login, no inherited rights.
      if (!exists) await tx.unsafe(`CREATE ROLE ${ident(name)} NOLOGIN NOINHERIT`);
      if (member && !joined) await tx.unsafe(`GRANT ${ident(name)} TO CURRENT_USER`);
    } catch (error) {
      if (error instanceof Refusal) throw error;
      refuse(
        `the target login cannot create or join the role ${name} (SQLSTATE ${error?.code ?? '?'}): create it NOLOGIN NOINHERIT and grant it to the login first`,
      );
    }
  }
}

class Different extends Error {}

// The scratch copy holds the database: Ctrl+C, SIGTERM or a closed terminal removes it before
// the process ends. An open target transaction is rolled back by the server when it drops.
const SCRATCH = { work: null };
export function onSignal(scratch = SCRATCH, say = console.error, exit = process.exit) {
  // A copy write already queued may land while this runs: retry, then name what is left.
  let left = false;
  if (scratch.work) {
    try {
      rmSync(scratch.work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Reported below.
    }
    left = existsSync(scratch.work);
  }
  say(
    left
      ? `Interrupted: nothing was committed, but the scratch copy ${scratch.work} is still there: delete that folder.`
      : 'Interrupted: the scratch copy was removed and nothing was committed.',
  );
  exit(NOT_COMPARED_EXIT);
}

/**
 * A CHECK that PGlite stored as nested ANDs (BETWEEN in 0026) comes back flattened once the
 * dump is parsed again, so its printed text differs although it is the same expression. For
 * each CHECK whose text differs, the target parses the source's own definition on an empty
 * temporary copy of the table's columns; only when that prints exactly what the restore made is
 * the source's text taken as the target's. Any other difference stays a difference.
 */
async function reparseChecks(tx, sourceTables, targetTables, say) {
  for (const [name, table] of Object.entries(sourceTables)) {
    const other = targetTables[name];
    if (!other) continue;
    for (const [key, def] of Object.entries(table.structure.keys)) {
      const now = other.structure.keys[key];
      if (now === undefined || now === def || !key.startsWith('constraint ') || !def.startsWith('CHECK'))
        continue;
      const [schema, relation] = name.includes('.') ? name.split('.', 2) : ['public', name];
      // In a savepoint: a definition the target cannot parse leaves the difference, not an
      // aborted transaction.
      const parsed = await tx
        .savepoint(async (sp) => {
          await sp.unsafe(
            `CREATE TEMP TABLE sipges_move_probe (LIKE ${ident(schema)}.${ident(relation)})`,
          );
          await sp.unsafe(
            `ALTER TABLE sipges_move_probe ADD CONSTRAINT sipges_move_probe_check ${def}`,
          );
          const [row] = await sp.unsafe(
            `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
             WHERE conname = 'sipges_move_probe_check' AND conrelid = 'sipges_move_probe'::regclass`,
          );
          await sp.unsafe('DROP TABLE sipges_move_probe');
          return row?.def;
        })
        .catch(() => null);
      if (parsed === now) {
        table.structure.keys[key] = now;
        say(
          `${name}: ${key.slice('constraint '.length)} re-parsed by the target to the same definition`,
        );
      }
    }
  }
}

/** Restores, compares and commits in one transaction; any difference rolls everything back. */
async function restore(postgres, url, source, say, afterRestore) {
  const sql = postgres(url.toString(), {
    max: 1,
    onnotice: () => {},
    connection: { application_name: 'sipges-pglite-move', ...SESSION },
  });
  try {
    await checkLogin(sql);
    return await sql.begin(async (tx) => {
      await checkEmpty(tx);
      await prepareRoles(tx, source.roles);
      try {
        await tx.unsafe(source.dump).simple();
        // The dump sets row_security off and an empty search_path for the session: back to the
        // settings the source is read with, or definitions would print schema-qualified.
        await tx.unsafe('RESET ALL');
      } catch (error) {
        refuse(
          `the dump did not load into the target (SQLSTATE ${error?.code ?? '?'}); nothing was committed`,
        );
      }
      if (afterRestore) await afterRestore(tx);
      // FORCE ROW LEVEL SECURITY binds the owner too, so its rows are read with it lifted and
      // the structure once it is back, all inside this transaction.
      const forced = await tx.unsafe(
        `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMAS} AND c.relforcerowsecurity`,
      );
      for (const t of forced)
        await tx.unsafe(`ALTER TABLE ${ident(t.schema)}.${ident(t.name)} NO FORCE ROW LEVEL SECURITY`);
      const rows = await readDatabase(driver(tx));
      for (const t of forced)
        await tx.unsafe(`ALTER TABLE ${ident(t.schema)}.${ident(t.name)} FORCE ROW LEVEL SECURITY`);
      const shape = await readDatabase(driver(tx));
      for (const [name, table] of Object.entries(rows.tables))
        table.structure = shape.tables[name]?.structure ?? table.structure;
      await reparseChecks(tx, source.tables.tables, rows.tables, say);
      const catalog = await readCatalog(driver(tx));
      const failed = report(source, rows, catalog, say);
      if (failed) throw new Different();
      return true;
    });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/** Prints the comparison; returns whether anything differs. */
function report(source, target, catalog, say) {
  const result = compareDatabases(source.tables.tables, target.tables, {
    rules: strictRules(source.tables.tables, target.tables),
    migrations: {},
    key: randomBytes(32),
    sequences: [source.tables.sequences, target.sequences],
  });
  for (const line of result.lines) say(line);
  let differences = result.differences;
  // tables.mjs only refuses a lower sequence; a move must keep every one exactly.
  for (const [name, value] of Object.entries(source.tables.sequences))
    if (Object.hasOwn(target.sequences, name) && target.sequences[name] !== value) {
      differences += 1;
      say(`sequence ${name}: last value differs`);
    }
  const changed = [];
  for (const [k, v] of Object.entries(source.catalog))
    if (!Object.hasOwn(catalog, k)) changed.push(`${k}: missing after`);
    else if (catalog[k] !== v) changed.push(`${k}: differs`);
  for (const k of Object.keys(catalog))
    if (!Object.hasOwn(source.catalog, k)) changed.push(`${k}: new`);
  say(
    `Functions, views, indexes, triggers, policies and grants: ${Object.keys(source.catalog).length} -> ${Object.keys(catalog).length}${changed.length ? '' : ', identical'}`,
  );
  for (const line of changed) say(`  ${line}`);
  differences += changed.length;
  const { line } = verdict({ differences, incomplete: result.incomplete });
  say(line);
  return differences > 0 || result.incomplete.length > 0;
}

/** The whole move. Returns the exit code. */
export async function runMove(
  options,
  { say = console.log, original = originalState(), afterRestore } = {},
) {
  try {
    if (!options.state) refuse('--state <copy of the state folder> is required');
    const url = checkTarget(options.to);
    const db = await checkCopy(options.state, original);
    const before = await treeDigest(db);
    const tools = await loadTools();
    say(`Source: a copy of the state folder; ${PGLITE} ${tools.pglite}, ${TOOLS} ${tools.tools}`);
    const source = await readSource(tools, db, options.scratch ?? tmpdir());
    if ((await treeDigest(db)) !== before)
      refuse('the copy changed while it was read: close every program using it and run again');
    say(`Source database read and dumped (PostgreSQL ${source.version}); the copy is unchanged`);
    await restore(tools.postgres, url, source, say, afterRestore);
    say('Moved: the target holds the copy, committed.');
    return 0;
  } catch (error) {
    if (error instanceof Different) {
      say('Nothing was committed: the target is as it was before.');
      return 1;
    }
    say(`RESULT: not moved: ${safeReason(error)}`);
    return NOT_COMPARED_EXIT;
  }
}

const USAGE = `Usage: SIPGES_MOVE_DATABASE_URL=postgres://<login>@127.0.0.1:<port>/<database> \\
  node deploy/desktop/migration/pglite-to-postgres.mjs --state <copy of the state folder> [--scratch <folder>]
--to <url> may replace the variable. Read deploy/desktop/migration/README.md.`;

async function main(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { state: { type: 'string' }, to: { type: 'string' }, scratch: { type: 'string' } },
    }).values;
  } catch {
    console.error(USAGE);
    return NOT_COMPARED_EXIT;
  }
  const to = parsed.to ?? (process.env.SIPGES_MOVE_DATABASE_URL || undefined);
  return runMove({ ...parsed, to });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => onSignal());
  process.exitCode = await main(process.argv.slice(2));
}
