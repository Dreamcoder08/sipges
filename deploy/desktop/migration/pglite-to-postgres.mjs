// One-time move of a desktop install's PGlite database into a native PostgreSQL 18 server, for
// the Go API (docs/adr/0036 §4). It reads a COPY of the state folder, never the original, and
// never opens even the copy: its pglite folder is copied to a scratch folder, only that is opened
// (PGlite writes to what it opens) and it is removed at the end. The copy is dumped logically
// with the pinned pglite-tools pgDump (plain SQL, --inserts, --no-owner) and restored into the
// target in ONE transaction, which also compares source and target table by table with
// tables.mjs, plus functions, views, indexes, triggers, policies, grants, column defaults,
// identity, generation and collation, table persistence, storage options, replica identity,
// comments, sequence parameters, default privileges and extensions. Any difference rolls the
// transaction back: the target is left empty. The copy's pglite folder is hashed before and
// after and must not change. Values are never printed: counts, names and keyed fingerprints only.
//
// Exit code 0: moved, no difference; 1: a difference (nothing committed); 2: refused or failed,
// with the reason. Read deploy/desktop/migration/README.md.
//
//   SIPGES_MOVE_DATABASE_URL=postgres://<login>@127.0.0.1:<port>/<database> \
//     node deploy/desktop/migration/pglite-to-postgres.mjs --state <copy of the state folder>
//     [--to <url>] [--prepared <state folder>] [--scratch <folder>] [--port 8000]
//
// --prepared <state folder>: the folder `sipges-desktop --prepare-only` prepared (the real one, not
// the copy); its pg18.pending-move, which keeps SIPGES off the empty cluster, is removed only
// after a committed move with no difference, and only when the target serves that folder's pg18.
import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdtemp, readFile, realpath, rm, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { endianness, homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { parseArgs } from 'node:util';
import {
  FRESH_MS,
  NOT_COMPARED_EXIT,
  Refusal,
  compareDatabases,
  freshLock,
  readDatabase,
  safeReason,
  treeDigest,
  verdict,
} from './tables.mjs';
import { portAnswers } from '../windows/visit-kit.mjs';

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
// The name readDatabase gives a relation: bare in public, schema-qualified elsewhere.
const RELATION = `CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END`;
// A role as the catalog names it, the owner (who changes by design) as OWNER.
const ROLE = (oid, owner) =>
  `CASE WHEN ${oid} = 0 THEN 'PUBLIC' WHEN ${oid} = ${owner} THEN 'OWNER' ELSE ${oid}::regrole::text END`;
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

/**
 * The scratch folder, refused inside the original state folder or inside the copy: the rule
 * tables.mjs applies to --scratch, checked before anything is created. Returns its real path.
 */
export async function checkScratch(given, copy, original = originalState()) {
  const real = await realpath(path.resolve(given)).catch(() =>
    refuse(`--scratch ${given} does not exist`),
  );
  if (!(await lstat(real)).isDirectory()) refuse(`--scratch ${given} is not a folder`);
  const originalReal = await realpath(original).catch(() => path.resolve(original));
  if (within(originalReal, real))
    refuse(
      `--scratch ${given} is inside the original state folder ${original}: pick a folder outside it`,
    );
  if (within(await realpath(copy), real))
    refuse(`--scratch ${given} is inside the copy given with --state: pick a folder outside it`);
  return real;
}

/**
 * The rule of tables.mjs for SIPGES running: something answers on the port, or the copy's PGlite
 * holds a postmaster.pid touched in the last two minutes (PGlite writes it on open and removes it
 * on close, so a fresh one in a copy means the copy was taken with the database open).
 */
export async function checkStopped(db, port, answers = portAnswers) {
  if (await answers(port))
    refuse(
      `SIPGES responde en el puerto ${port}: cierre SIPGES por completo, copie la carpeta otra vez y vuelva a ejecutar`,
    );
  if (await freshLock(path.join(db, 'postmaster.pid')))
    refuse(
      `la copia se tomó con SIPGES abierto (pglite/postmaster.pid de hace menos de ${FRESH_MS / 60_000} minutos): cierre SIPGES y copie la carpeta otra vez`,
    );
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
 * definitions, grants and default privileges (the owner as OWNER, since the owner changes by
 * design), each column's default, identity, generation, collation and comment, each table's
 * persistence, storage options, replica identity and comment, each sequence's parameters, and
 * the extensions. `{ name: digest }`, so no definition text is ever printed.
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
      `SELECT n.nspname || '.' || c.relname AS k, md5(concat_ws('|', pg_get_indexdef(i.indexrelid),
         i.indisreplident, i.indisclustered)) AS v
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
  add(
    'column',
    await pairs(
      db,
      `SELECT ${RELATION} || '.' || a.attname AS k, md5(concat_ws('|',
         coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), a.attidentity, a.attgenerated,
         coalesce(co.collname, '-'), coalesce(col_description(c.oid, a.attnum), '-'))) AS v
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_collation co ON co.oid = a.attcollation
       WHERE ${USER_SCHEMAS} AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`,
    ),
  );
  add(
    'table',
    await pairs(
      db,
      `SELECT ${RELATION} AS k, md5(concat_ws('|', c.relpersistence,
         coalesce(array_to_string(c.reloptions, ','), '-'), c.relreplident,
         coalesce(obj_description(c.oid, 'pg_class'), '-'))) AS v
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${USER_SCHEMAS} AND c.relkind IN ('r', 'p')`,
    ),
  );
  add(
    'sequence',
    await pairs(
      db,
      `SELECT n.nspname || '.' || c.relname AS k, concat_ws(' ', s.seqtypid::regtype::text,
         s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle, c.relpersistence) AS v
       FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMAS}`,
    ),
  );
  add(
    'default privileges',
    await pairs(
      db,
      `SELECT 'of ' || ${ROLE('a.defaclrole', "(SELECT oid FROM pg_roles WHERE rolname = current_user)")}
         || ' in ' || coalesce(n.nspname, 'every schema') || ' on ' || a.defaclobjtype::text
         || ' to ' || ${ROLE('e.grantee', 'a.defaclrole')} || ' ' || e.privilege_type AS k,
         CASE WHEN e.is_grantable THEN 'grantable' ELSE '' END AS v
       FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid = a.defaclnamespace,
         aclexplode(a.defaclacl) e`,
    ),
  );
  add(
    'extension',
    await pairs(
      db,
      `SELECT e.extname AS k, e.extversion || ' in ' || n.nspname AS v
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace`,
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

/**
 * Copies the pglite folder to scratch, dumps and reads it there, and removes the copy. The run
 * removes it, never the signal handler: every step under `work` has been awaited by then.
 */
async function readSource(tools, db, scratchRoot, stop) {
  checkpoint(stop);
  const work = await mkdtemp(path.join(scratchRoot, 'sipges-pglite-move-'));
  stop.work = work;
  let result;
  let failure = null;
  try {
    const dir = path.join(work, 'pglite');
    await cp(db, dir, { recursive: true });
    checkpoint(stop);
    const pg = new tools.PGlite(dir);
    try {
      await pg.waitReady;
      const version = (await pg.query('SHOW server_version_num')).rows[0].server_version_num;
      const file = await tools.pgDump({ pg, args: DUMP_ARGS });
      const dump = await file.text();
      checkpoint(stop);
      for (const [k, v] of Object.entries(SESSION)) await pg.exec(`SET ${k} = '${v}'`);
      const tables = await readDatabase(pg);
      const catalog = await readCatalog(pg);
      const roles = await sourceRoles(pg);
      result = { version, dump, tables, catalog, roles };
    } finally {
      await pg.close().catch(() => {});
    }
  } catch (error) {
    failure = error;
  }
  await rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  if (await lstat(work).then(() => true, () => false))
    refuse(`the scratch copy ${work} could not be removed: delete that folder`);
  stop.work = null;
  if (failure) throw failure;
  checkpoint(stop);
  return result;
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

// Set by Ctrl+C (SIGINT), SIGTERM or a closed terminal (SIGHUP). `work`: the scratch copy while
// it exists; `committing`: COMMIT was sent, so the outcome is the server's, not ours.
const STOP = { requested: false, work: null, committing: false };

/**
 * A signal only asks the run to stop, as in tables.mjs: removing the scratch copy from the
 * handler raced the copy still being written. The run stops at its next step, removes the copy
 * and rolls back an open transaction; once COMMIT was sent it never claims nothing was committed.
 */
export function onSignal(stop = STOP, say = console.error) {
  stop.requested = true;
  if (stop.committing)
    say('Interrupted while committing: wait for the RESULT line; it says whether the move was committed.');
  else if (stop.work)
    say(
      `Interrupted: removing the scratch copy ${stop.work}; wait for the RESULT line. If this window is closed first, delete that folder.`,
    );
  else say('Interrupted: stopping; wait for the RESULT line.');
}

function checkpoint(stop) {
  if (stop.requested) refuse('interrupted; nothing was committed');
}

// Connection failures, told apart from file system errors (safeReason calls both errno codes).
const CONNECTION = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT']);
const connectionError = (error) =>
  CONNECTION.has(error?.code) || error?.syscall === 'connect';

/**
 * The CHECKs whose printed text changes when the dump is parsed again, although the expression is
 * the same: PGlite stored the BETWEEN of media_feeds_url_check (0026) as nested ANDs, and the
 * target prints the re-parsed text as one flat AND. Only these are re-parsed; a text difference
 * in any other constraint stays a difference. `table.constraint`.
 */
export const REPARSED_CHECKS = new Set(['media_feeds.media_feeds_url_check']);

/**
 * For each CHECK of REPARSED_CHECKS whose text differs, the target parses the source's own
 * definition on an empty temporary copy of the table's columns; only when that prints exactly
 * what the restore made is the source's text taken as the target's.
 */
async function reparseChecks(tx, sourceTables, targetTables, say) {
  for (const [name, table] of Object.entries(sourceTables)) {
    const other = targetTables[name];
    if (!other) continue;
    for (const [key, def] of Object.entries(table.structure.keys)) {
      const now = other.structure.keys[key];
      if (
        now === undefined ||
        now === def ||
        !key.startsWith('constraint ') ||
        !def.startsWith('CHECK') ||
        !REPARSED_CHECKS.has(`${name}.${key.slice('constraint '.length)}`)
      )
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
async function restore(postgres, url, source, say, afterRestore, stop) {
  const sql = postgres(url.toString(), {
    max: 1,
    onnotice: () => {},
    connection: { application_name: 'sipges-pglite-move', ...SESSION },
  });
  try {
    await checkLogin(sql);
    await sql.begin(async (tx) => {
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
      checkpoint(stop);
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
      checkpoint(stop);
      // Returning sends COMMIT: from here the outcome is the server's.
      stop.committing = true;
    });
    stop.committing = false;
  } catch (error) {
    if (stop.committing)
      refuse(
        `the connection failed after COMMIT was sent (${error?.code ?? 'unknown'}): the target may hold the move; check it before running again`,
      );
    if (error instanceof Different || error instanceof Refusal) throw error;
    if (connectionError(error))
      refuse(
        error.syscall === 'connect' || error.code === 'ECONNREFUSED' || error.code === 'CONNECT_TIMEOUT'
          ? `could not connect to the target server (${error.code}): start it and check --to; nothing was written`
          : `the connection to the target server failed (${error.code}); the server rolls back an open transaction, nothing was committed`,
      );
    throw error;
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
    `Catalog (functions, views, indexes, triggers, policies, grants, columns, tables, sequences, default privileges, extensions): ${Object.keys(source.catalog).length} -> ${Object.keys(catalog).length}${changed.length ? '' : ', identical'}`,
  );
  for (const line of changed) say(`  ${line}`);
  differences += changed.length;
  const { line } = verdict({ differences, incomplete: result.incomplete });
  say(line);
  return differences > 0 || result.incomplete.length > 0;
}

// The mark `sipges-desktop --prepare-only` leaves beside <state>/pg18: nothing starts SIPGES on
// that empty cluster until a committed move with no difference removes it (--prepared <state>).
export const PENDING_MOVE = 'pg18.pending-move';

/** The pending-move mark of the prepared (real) state folder, a plain file; refused otherwise. */
async function checkPrepared(folder) {
  const mark = path.join(path.resolve(folder), PENDING_MOVE);
  const info = await lstat(mark).catch(() => null);
  if (!info?.isFile())
    refuse(`--prepared names no folder that sipges-desktop --prepare-only prepared (no ${PENDING_MOVE})`);
  return mark;
}

// Fields of the cluster folder that identify the server running on it: the system identifier is
// the first field of global/pg_control (a uint64 in the host's byte order, as PostgreSQL writes
// it), and the fourth line of postmaster.pid is the port the postmaster listens on.
async function clusterIdentity(dir) {
  const control = await readFile(path.join(dir, 'global', 'pg_control')).catch(() => null);
  const pid = await readFile(path.join(dir, 'postmaster.pid'), 'utf8').catch(() => null);
  return {
    id: control && control.length >= 8 ? String(endianness() === 'LE' ? control.readBigUInt64LE(0) : control.readBigUInt64BE(0)) : null,
    port: pid ? Number(pid.split(/\r?\n/)[3]) : null,
  };
}

/**
 * Refuses a --prepared folder whose pg18 the target does not serve, before anything is read or
 * written: a wrong folder would lose its mark while the right cluster stays empty. The server's
 * data_directory decides when the login may read it (pg_read_all_settings); the API's login may
 * not, so then the cluster must match by system identifier (pg_control_system(), readable by any
 * login) and by the port its postmaster.pid names, which is the port the target answered on.
 */
export async function checkServed(postgres, url, stateDir, platform = process.platform) {
  const cluster = path.join(stateDir, 'pg18');
  const wrong = () =>
    refuse(
      `el servidor de destino no sirve la carpeta ${cluster} de --prepared: indique la carpeta de datos que preparó sipges-desktop --prepare-only y arranque su clúster; no se escribió nada`,
    );
  const real = await realpath(cluster).catch(() => null);
  if (!real) wrong();
  const same = (a, b) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {}, connection: { application_name: 'sipges-pglite-move' } });
  try {
    let served = null;
    try {
      [{ data_directory: served }] = await sql`SHOW data_directory`;
    } catch (error) {
      if (error?.code !== '42501') throw error;
    }
    if (served !== null) {
      if (!same(await realpath(served).catch(() => path.resolve(served)), real)) wrong();
      return;
    }
    const [{ id, port }] = await sql`SELECT system_identifier::text AS id, inet_server_port() AS port FROM pg_control_system()`;
    const local = await clusterIdentity(real);
    if (local.id !== id || local.port !== port) wrong();
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (connectionError(error))
      refuse(`could not connect to the target server (${error.code}): start it and check --to; nothing was written`);
    throw error;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/** The command that removes the mark by hand, for the shell the install uses. */
export function removeCommand(mark, platform = process.platform) {
  return platform === 'win32'
    ? `Remove-Item -LiteralPath '${mark.replaceAll("'", "''")}'`
    : `rm -- '${mark.replaceAll("'", "'\\''")}'`;
}

/**
 * The whole move. Returns the exit code. Hooks (tests): `afterRestore(tx)`, `answers(port)`, the
 * stop flag.
 */
export async function runMove(
  options,
  {
    say = console.log,
    original = originalState(),
    afterRestore,
    answers = portAnswers,
    stop = STOP,
  } = {},
) {
  try {
    if (!options.state) refuse('--state <copy of the state folder> is required');
    const port = Number(options.port ?? 8000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) refuse('invalid --port');
    const url = checkTarget(options.to);
    const db = await checkCopy(options.state, original);
    const pending = options.prepared ? await checkPrepared(options.prepared) : null;
    const tools = await loadTools();
    if (pending) await checkServed(tools.postgres, url, path.dirname(pending));
    const scratch = await checkScratch(options.scratch ?? tmpdir(), path.dirname(db), original);
    await checkStopped(db, port, answers);
    const before = await treeDigest(db);
    say(`Source: a copy of the state folder; ${PGLITE} ${tools.pglite}, ${TOOLS} ${tools.tools}`);
    const source = await readSource(tools, db, scratch, stop);
    if ((await treeDigest(db)) !== before)
      refuse('the copy changed while it was read: close every program using it and run again');
    say(`Source database read and dumped (PostgreSQL ${source.version}); the copy is unchanged`);
    await restore(tools.postgres, url, source, say, afterRestore, stop);
    say('Moved: the target holds the copy, committed.');
    if (pending) {
      try {
        await unlink(pending);
      } catch (error) {
        say(
          `The move committed, but ${PENDING_MOVE} could not be removed (${error.code ?? 'error'}): remove it by hand before opening SIPGES:`,
        );
        say(`  ${removeCommand(pending)}`);
        return NOT_COMPARED_EXIT;
      }
      say(`The prepared cluster is ready: removed ${PENDING_MOVE}.`);
    }
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
  node deploy/desktop/migration/pglite-to-postgres.mjs --state <copy of the state folder> [--prepared <state folder>] [--scratch <folder>] [--port 8000]
--to <url> may replace the variable; --port is where SIPGES would answer if it were running.
--prepared names the state folder sipges-desktop --prepare-only prepared, whose pg18 the target must
serve: its pg18.pending-move is removed only after a committed move with no difference. Read deploy/desktop/migration/README.md.`;

async function main(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        state: { type: 'string' },
        to: { type: 'string' },
        scratch: { type: 'string' },
        port: { type: 'string' },
        prepared: { type: 'string' },
      },
    }).values;
  } catch {
    console.error(USAGE);
    return NOT_COMPARED_EXIT;
  }
  const to = parsed.to ?? (process.env.SIPGES_MOVE_DATABASE_URL || undefined);
  return runMove({ ...parsed, to });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => onSignal());
  // A reader that went away (EPIPE, EIO) must not end the process before the run cleans up.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  process.exitCode = await main(process.argv.slice(2));
}
