// Offline comparison, table by table and column by column, of the database of a state folder as
// it was before the migration (the launcher's `<state>.pre-update-<time>-first-start-<version>`
// copy) and of the migrated state folder, with SIPGES stopped. Identity and sealed columns are
// compared byte for byte too, and so is the structure (column types and nullability, keys and
// constraints, row-level security, policies, triggers, sequences). It never opens either folder:
// only its pglite database folder is copied to a fresh scratch folder (never data-key,
// admin-password or uploads), only the copies are opened (PGlite may write to what it opens) and
// they are removed at the end, also on Ctrl+C; each database folder is hashed before and after
// and must not change. It prints counts, table and column names and 8-hex fingerprints keyed
// with a random per-run key, never a value.
// Exit code 0: no difference; 1: a difference or a part not fully compared; 2: not compared (a
// refusal or an error, with the reason). Read deploy/desktop/migration/README.md.
//
//   node deploy/desktop/migration/tables.mjs --before <folder> --after <folder>
//        [--app <install root>] [--scratch <folder>] [--port 8000]
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  statfs,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { constants, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { readCurrent, readStateDir } from '../updater/updater.mjs';
import { portAnswers } from '../windows/visit-kit.mjs';

export const NOT_COMPARED_EXIT = 2;
const LISTED = 20;
// Like the update lock (updater.mjs LOCK_STALE_MS): a lock touched this recently is in use.
const FRESH_MS = 120_000;
const ENTRY_OVERHEAD = 4096;
const OPEN_MARGIN = 64 * 1024 * 1024;
const OLD_ADMIN = 'mascli-admin';
const NEW_ADMIN = 'sipges-admin';

/**
 * Migrations whose rewrite of stored rows is declared in RULES. Any other migration applied
 * between the two folders leaves the run "not fully compared": its effect is not declared here.
 * 0030 and 0031 rewrite tenant ids in every table and delete empty tenants; every install this
 * tool is meant for (from the first clone installer, 6d867050, on) already has them.
 */
export const MIGRATIONS = {
  '0032': '0032_rename_admin_username.sql renames the login mascli-admin to sipges-admin',
};

// 0032: the column of its reviewed list in each table (sessions and login_failures are
// ephemeral here); a value exactly mascli-admin before reads as sipges-admin after.
const RENAMED_0032 = {
  api_keys: 'created_by',
  attachments: 'author',
  automation_rules: 'created_by',
  digital_alert_reviews: 'first_validator',
  document_review: 'reviewer',
  grants: 'username',
  integration_channels: 'created_by',
  link_evidence_history: 'actor',
  media_feeds: 'updated_by',
  notification_reads: 'username',
  preventive_action_log: 'decided_by',
  preventive_actions: 'responsible',
  project_settings: 'updated_by',
  proposal_decisions: 'decided_by',
  push_deliveries: 'username',
  push_subscriptions: 'username',
  record_links: 'created_by',
  record_versions: 'actor',
  source_import_settings: 'updated_by',
  users: 'username',
};
const renamed = (column) => ({
  migration: '0032',
  text: `${column} ${OLD_ADMIN} -> ${NEW_ADMIN}`,
  map: (row) => (row[column] === OLD_ADMIN ? { ...row, [column]: NEW_ADMIN } : row),
});
// 0032 also rewrites audit.detail written by the alert store's two templates, nothing else.
const [FIRST, LATER] = ['Primera validación: ', ' (primera validación: '];
const auditDetail = {
  migration: '0032',
  text: `detail templates naming ${OLD_ADMIN} -> ${NEW_ADMIN}`,
  map: (row) => {
    const detail = row.detail;
    if (detail === `${FIRST}${OLD_ADMIN}`) return { ...row, detail: `${FIRST}${NEW_ADMIN}` };
    if (detail?.endsWith(`${LATER}${OLD_ADMIN})`))
      return { ...row, detail: `${detail.slice(0, -OLD_ADMIN.length - 1)}${NEW_ADMIN})` };
    return row;
  },
};
const TICK = ['status', 'attempts', 'next_attempt_at', 'last_error'];
const POLL = ['last_poll_at', 'last_poll_error', 'last_imported'];
const [SAME, MORE, CHANGE, GONE] = ['identical', 'superset', 'expected-change', 'ephemeral'];

/**
 * One rule per table of the app (schema public; a table in any other schema has none).
 * kind: identical (same rows, every common column); superset (`rows`: rows may be added;
 * `columns`: { column: migration } may be added when that migration ran; `addedIn`: the table
 * may be new when that migration ran); expected-change (identical once `expect.map` is applied
 * to the rows before, when `expect.migration` ran between the two, otherwise identical; `rows`
 * as superset); ephemeral (counts only). `mayChange`: columns left out of the comparison;
 * `grows`: integer columns that may only stay or increase. Hash, sealed and token columns are
 * compared byte for byte like every other column. Structure is compared for every table.
 */
export const RULES = {
  api_keys: { kind: CHANGE, mayChange: ['last_used_at'], why: 'key hashes; moved at each use' },
  attachments: { kind: CHANGE, why: 'upload metadata and content sha256' },
  audit: { kind: CHANGE, rows: true, why: 'append-only: sign-ins and work add entries' },
  automation_cursors: {
    kind: MORE,
    rows: true,
    grows: ['last_audit_id'],
    mayChange: ['token', 'source', 'started_at', 'finished_at', 'status', 'report', 'error'].map(
      (c) => `last_tick_${c}`,
    ),
    why: "the tick's durable audit position: a lost or lowered cursor replays or skips automations",
  },
  automation_rules: { kind: CHANGE, why: 'automation rules written by people' },
  automation_runs: {
    kind: MORE,
    rows: true,
    mayChange: [...TICK, 'finished_at'],
    why: 'the in-process tick adds runs and retries pending ones',
  },
  digital_alert_reviews: { kind: CHANGE, why: 'alert reviews and their four-eyes validator' },
  digital_signal_dedup_locks: {
    kind: MORE,
    rows: true,
    why: 'dedup keys; the app never deletes them',
  },
  document_review: { kind: CHANGE, why: 'document reviews' },
  grants: { kind: CHANGE, why: "every account's project grants" },
  ingest_receipts: { kind: MORE, rows: true, why: 'idempotency receipts; integrations add some' },
  integration_channels: { kind: CHANGE, why: 'channel settings, sealed, byte for byte' },
  irsa_configs: { kind: SAME, why: 'IRSA configuration per project' },
  irsa_snapshots: { kind: SAME, why: 'IRSA history' },
  link_evidence_history: { kind: CHANGE, why: 'history of link evidence' },
  login_failures: { kind: GONE, why: 'sign-in throttling window; rows expire' },
  media_feeds: { kind: CHANGE, mayChange: [...POLL, 'last_matched'], why: 'the tick polls feeds' },
  module_records: { kind: SAME, why: 'the records, with their marking and created_at' },
  notification_reads: { kind: CHANGE, rows: true, why: 'reading a notification adds a row' },
  notifications: { kind: MORE, rows: true, why: 'automations add notifications' },
  preventive_action_log: { kind: CHANGE, why: 'preventive action decisions' },
  preventive_actions: { kind: CHANGE, why: 'preventive actions' },
  project_settings: { kind: CHANGE, why: 'project settings' },
  proposal_decisions: { kind: CHANGE, why: 'analyst proposal decisions' },
  push_deliveries: { kind: CHANGE, rows: true, mayChange: TICK, why: 'the tick adds and retries' },
  push_subscriptions: { kind: CHANGE, rows: true, why: 'push keys; a browser may subscribe' },
  record_embeddings: {
    kind: MORE,
    rows: true,
    mayChange: ['model', 'vector', 'source_hash', 'embedded_at'],
    why: 'derived search index refilled in the background; no row may vanish',
  },
  record_links: { kind: CHANGE, why: 'links between records' },
  record_versions: { kind: CHANGE, why: 'record history' },
  schema_migrations: { kind: MORE, rows: true, why: 'the migrations of this start add versions' },
  sessions: { kind: GONE, why: 'sign-in sessions: each sign-in adds one, they expire' },
  source_import_settings: {
    kind: CHANGE,
    mayChange: [...POLL, 'last_duplicates'],
    why: 'authorized sources; the tick polls them',
  },
  tenants: { kind: SAME, why: 'projects and their labels' },
  users: {
    kind: CHANGE,
    mayChange: ['totp_last_step'],
    why: 'password hashes, sealed MFA secrets; totp_last_step moves at each MFA sign-in',
  },
};
for (const [name, rule] of Object.entries(RULES))
  if (rule.kind === CHANGE)
    rule.expect = name === 'audit' ? auditDetail : renamed(RENAMED_0032[name]);

/** A refusal or an error whose message is ours: safe to print. */
export class Refusal extends Error {}
const refuse = (message) => {
  throw new Refusal(message);
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const inside = (parent, child) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
};

/** Every entry of a folder: refuses links, junctions and special files. */
async function entries(root) {
  const out = [];
  const walk = async (dir) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) {
        out.push({ rel, dir: true });
        await walk(path);
      } else if (entry.isFile()) out.push({ rel, path, size: (await lstat(path)).size });
      else refuse(`${root} holds a link, junction or special file (${rel}); pass a plain copy`);
    }
  };
  await walk(root);
  return out;
}

const hashFile = (path) =>
  new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', fail)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')));
  });

/** Names, sizes and bytes of a folder, as one digest. */
export async function treeDigest(root) {
  const hash = createHash('sha256');
  for (const entry of await entries(root))
    hash.update(
      entry.dir
        ? `d ${entry.rel}\n`
        : `f ${entry.rel} ${entry.size} ${await hashFile(entry.path)}\n`,
    );
  return hash.digest('hex');
}

/** Refuses an input that is a link, not a state folder, or holds a link; returns its real path and size. */
async function checkInput(label, path) {
  const info = await lstat(path).catch(() => refuse(`${label} ${path} does not exist`));
  if (info.isSymbolicLink()) refuse(`${label} ${path} is a link or junction; pass the real folder`);
  if (!info.isDirectory()) refuse(`${label} ${path} is not a folder`);
  const version = await lstat(join(path, 'pglite', 'PG_VERSION')).catch(() => null);
  if (!version?.isFile())
    refuse(`${label} ${path} is not a SIPGES state folder (no pglite database)`);
  await entries(path);
  // Only the database folder is copied, so only it needs room.
  const list = await entries(join(path, 'pglite'));
  const bytes = list.reduce((sum, e) => sum + (e.size ?? 0) + ENTRY_OVERHEAD, ENTRY_OVERHEAD);
  return { real: await realpath(path), bytes };
}

/** A lock file touched in the last FRESH_MS (its heartbeat, else its file time). */
async function freshLock(path) {
  const info = await stat(path).catch(() => null);
  if (!info) return false;
  let beat = NaN;
  try {
    beat = Date.parse(JSON.parse(await readFile(path, 'utf8'))?.heartbeat ?? '');
  } catch {
    // Not JSON (postmaster.pid): its file time decides.
  }
  return Date.now() - (Number.isFinite(beat) ? beat : info.mtimeMs) < FRESH_MS;
}

/**
 * SIPGES running or a database open: something answers on the port, an input's PGlite holds a
 * recent postmaster.pid (PGlite writes it on open and removes it on close; a killed process
 * leaves it, so only a recent one counts), or an install root (--app, or one beside an input
 * that records it as its state folder) holds a fresh update.lock (an update or first start).
 */
async function checkStopped(inputs, { app, port, answers }) {
  if (await answers(port))
    refuse(`SIPGES answers on port ${port}: close it completely (SIPGES cerrado) and run again`);
  for (const { label, real } of inputs)
    if (await freshLock(join(real, 'pglite', 'postmaster.pid')))
      refuse(
        `the database in ${label} was opened in the last ${FRESH_MS / 1000} s (pglite/postmaster.pid): close SIPGES, wait two minutes and run again`,
      );
  const roots = new Set(app ? [app] : []);
  for (const { real } of inputs)
    for (const entry of await readdir(dirname(real), { withFileTypes: true }).catch(() => []))
      if (entry.isDirectory()) {
        const root = join(dirname(real), entry.name);
        const state = await readStateDir(root).catch(() => null);
        if (state && (await realpath(state).catch(() => state)) === real) roots.add(root);
      }
  for (const root of roots)
    if (await freshLock(join(root, 'update.lock')))
      refuse(`an update or first start is running in ${root} (update.lock): wait for it to end`);
}

/** Free space of the scratch drive for both copies, or a refusal. */
export async function checkRoom(scratch, needed, fs = statfs) {
  const disk = await fs(scratch);
  const free = Number(disk.bavail) * Number(disk.bsize);
  if (free < needed)
    refuse(
      `not enough free space in --scratch ${scratch} for both copies: ${needed} bytes needed, ${free} free`,
    );
}

/** PGlite from the installed version of --app (its api/node_modules), else from this checkout. */
async function loadPGlite(app) {
  const from = [];
  if (app) {
    const current = await readCurrent(app).catch(() => null);
    if (!current) refuse(`--app ${app} is not a managed install root (no current.json)`);
    from.push(join(current.dir, 'api', 'package.json'));
  } else from.push(join(dirname(fileURLToPath(import.meta.url)), '../../../apps/api/package.json'));
  for (const parent of from)
    try {
      const entry = createRequire(parent).resolve('@electric-sql/pglite');
      return (await import(pathToFileURL(entry).href)).PGlite;
    } catch {
      // Not installed there.
    }
  return refuse(
    `PGlite not found in ${from[0]}: pass --app <install root>, the managed install (SIPGES-app)`,
  );
}

const ident = (name) => `"${name.replace(/"/g, '""')}"`;

/** Rows of one catalog query. */
const rowsOf = async (db, sql, params = []) => (await db.query(sql, params)).rows;

/**
 * Every table of the app's schemas and every sequence: `{ tables: { name: { columns, pk, rows,
 * structure } }, sequences: { name: last value } }`, values as text. `structure`: columns with
 * type and nullability, constraints and unique indexes, row-level security, policy names,
 * trigger names with their enabled state.
 */
export async function readDatabase(db) {
  const tables = await rowsOf(
    db,
    `SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls,
       c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`,
  );
  const out = Object.create(null);
  for (const table of tables) {
    const cols = await rowsOf(
      db,
      `SELECT attname, format_type(atttypid, atttypmod) AS type, attnotnull FROM pg_attribute
       WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
      [table.oid],
    );
    const keys = await rowsOf(
      db,
      `SELECT a.attname FROM pg_index i, unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
       JOIN pg_attribute a ON a.attnum = k.attnum WHERE i.indrelid = $1 AND i.indisprimary
       AND a.attrelid = $1 ORDER BY k.n`,
      [table.oid],
    );
    const constraints = await rowsOf(
      db,
      `SELECT 'constraint ' || conname AS name, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid = $1
       UNION ALL SELECT 'unique index ' || c.relname, pg_get_indexdef(i.indexrelid)
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = $1
       AND i.indisunique AND NOT EXISTS (SELECT FROM pg_constraint k WHERE k.conindid = i.indexrelid)`,
      [table.oid],
    );
    const policies = await rowsOf(db, 'SELECT polname FROM pg_policy WHERE polrelid = $1', [
      table.oid,
    ]);
    const triggers = await rowsOf(
      db,
      'SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal',
      [table.oid],
    );
    const columns = cols.map((c) => c.attname);
    const select = columns.map((c) => `${ident(c)}::text`).join(', ');
    const { rows } = await db.query(
      `SELECT ${select || 'NULL'} FROM ${ident(table.schema)}.${ident(table.name)}`,
      [],
      { rowMode: 'array' },
    );
    const name = table.schema === 'public' ? table.name : `${table.schema}.${table.name}`;
    out[name] = {
      columns,
      pk: keys.length ? keys.map((k) => k.attname) : null,
      rows,
      structure: {
        columns: bare(cols.map((c) => [c.attname, { type: c.type, notnull: c.attnotnull }])),
        keys: bare(constraints.map((k) => [k.name, k.def])),
        rls: { enabled: table.rls, forced: table.forced },
        policies: policies.map((p) => p.polname).sort(),
        triggers: bare(triggers.map((g) => [g.tgname, g.tgenabled])),
      },
    };
  }
  const sequences = await rowsOf(
    db,
    `SELECT schemaname AS schema, sequencename AS name, last_value::text AS value FROM pg_sequences
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
  );
  return {
    tables: out,
    sequences: bare(
      sequences.map((q) => [q.schema === 'public' ? q.name : `${q.schema}.${q.name}`, q.value]),
    ),
  };
}

/** Whether an integer value (text, or null when unset) went back. */
const lower = (was, now) =>
  was !== null &&
  was !== undefined &&
  (now === null || now === undefined || BigInt(now) < BigInt(was));

/**
 * A map without a prototype. Table, column, trigger, sequence and migration names come from the
 * database: on a plain object `constructor` or `toString` would find an inherited member, and
 * `__proto__` would not be stored at all.
 */
const bare = (entries) => {
  const out = Object.create(null);
  for (const [k, v] of entries) out[k] = v;
  return out;
};
const bareCopy = (object) => bare(Object.entries(object));

/** Removed, added and changed entries of two maps, labelled. Own entries only. */
function mapChanges(was, now, label, changed = () => 'differs') {
  const out = [];
  for (const [k, v] of Object.entries(was))
    if (!Object.hasOwn(now, k)) out.push(`${label}${k} missing after`);
    else if (now[k] !== v) out.push(`${label}${k} ${changed(v, now[k])}`);
  for (const k of Object.keys(now)) if (!Object.hasOwn(was, k)) out.push(`${label}${k} new`);
  return out;
}

/** Structure differences of one table; columns missing or new are reported with its rows. */
function structureProblems(was, now) {
  if (!was || !now) return was || now ? ['structure not readable on one side'] : [];
  const out = [];
  for (const [name, col] of Object.entries(was.columns)) {
    if (!Object.hasOwn(now.columns, name)) continue;
    const other = now.columns[name];
    if (col.type !== other.type) out.push(`column ${name} type ${col.type} -> ${other.type}`);
    if (col.notnull !== other.notnull)
      out.push(`column ${name} ${col.notnull ? 'NOT NULL -> nullable' : 'nullable -> NOT NULL'}`);
  }
  out.push(...mapChanges(was.keys, now.keys, ''));
  const state = (on, yes, no) => (on ? yes : no);
  if (was.rls.enabled !== now.rls.enabled)
    out.push(
      `row-level security ${state(was.rls.enabled, 'enabled', 'disabled')} -> ${state(now.rls.enabled, 'enabled', 'disabled')}`,
    );
  if (was.rls.forced !== now.rls.forced)
    out.push(
      `row-level security ${state(was.rls.forced, 'forced', 'not forced')} -> ${state(now.rls.forced, 'forced', 'not forced')}`,
    );
  const set = (names) => bare(names.map((n) => [n, true]));
  out.push(...mapChanges(set(was.policies), set(now.policies), 'policy '));
  out.push(...mapChanges(was.triggers, now.triggers, 'trigger ', (a, b) => `enabled ${a} -> ${b}`));
  return out;
}

const objects = (table) => table.rows.map((row) => bare(table.columns.map((c, i) => [c, row[i]])));

/** One table present on both sides: `{ line, problems }`. */
function compareTable(name, rule, was, now, applied, fp) {
  const label = `${name}: ${was.rows.length} -> ${now.rows.length}`;
  if (rule.kind === GONE)
    return { line: `${name}: ephemeral, ${was.rows.length} -> ${now.rows.length}`, problems: [] };
  const problems = was.columns
    .filter((c) => !now.columns.includes(c))
    .map((c) => `column ${c} missing after`);
  const added = now.columns.filter((c) => !was.columns.includes(c));
  const allowed = added.filter(
    (c) => rule.columns && Object.hasOwn(rule.columns, c) && applied.has(rule.columns[c]),
  );
  problems.push(...added.filter((c) => !allowed.includes(c)).map((c) => `column ${c} new`));
  const skip = new Set([...(rule.mayChange ?? []), ...(rule.grows ?? [])]);
  const common = was.columns.filter((c) => now.columns.includes(c) && !skip.has(c));
  const active = Boolean(rule.expect && applied.has(rule.expect.migration));
  let before = objects(was);
  let changed = 0;
  if (active)
    before = before.map((row) => {
      const mapped = rule.expect.map(row);
      if (mapped !== row) changed += 1;
      return mapped;
    });
  const after = objects(now);
  const samePk =
    was.pk && now.pk && was.pk.join() === now.pk.join() && was.pk.every((c) => common.includes(c));
  const values = (row, columns) => JSON.stringify(columns.map((c) => row[c]));
  let rowsAdded = 0;
  if (samePk) {
    const byKey = new Map(after.map((row) => [values(row, was.pk), row]));
    for (const row of before) {
      const key = values(row, was.pk);
      const other = byKey.get(key);
      byKey.delete(key);
      if (!other) problems.push(`row [${fp(key)}] missing`);
      else {
        const differ = common.filter((c) => row[c] !== other[c]);
        if (differ.length) problems.push(`row [${fp(key)}] differs in ${differ.join(', ')}`);
        for (const c of rule.grows ?? [])
          if (lower(row[c], other[c])) problems.push(`row [${fp(key)}] ${c} decreased`);
      }
    }
    for (const key of byKey.keys())
      if (rule.rows) rowsAdded += 1;
      else problems.push(`row [${fp(key)}] new`);
  } else {
    const left = new Map();
    for (const row of after)
      left.set(values(row, common), (left.get(values(row, common)) ?? 0) + 1);
    let missing = 0;
    for (const row of before) {
      const n = left.get(values(row, common)) ?? 0;
      if (n > 0) left.set(values(row, common), n - 1);
      else missing += 1;
    }
    const extra = [...left.values()].reduce((sum, n) => sum + n, 0);
    if (missing) problems.push(`${plural(missing, 'row')} missing or changed (no primary key)`);
    if (extra && rule.rows) rowsAdded = extra;
    else if (extra) problems.push(`${plural(extra, 'row')} new or changed (no primary key)`);
  }
  if (problems.length) return { line: label, problems };
  let text = active
    ? `expected change (${rule.expect.migration}): ${rule.expect.text} in ${plural(changed, 'row')}, every other value identical`
    : 'identical';
  if (rule.mayChange?.length) text += ` except ${rule.mayChange.join(', ')}`;
  if (rule.grows?.length) text += `, ${rule.grows.join(', ')} not lower`;
  if (rule.expect && !active) text += ` (${rule.expect.migration} not run between the two)`;
  if (allowed.length) text += `, ${plural(allowed.length, 'column')} added: ${allowed.join(', ')}`;
  if (rowsAdded) text += `, ${plural(rowsAdded, 'row')} added`;
  return { line: `${label}, ${text}`, problems };
}

/**
 * Compares two databases read with readDatabase. Returns `{ lines, differences, incomplete }`:
 * `incomplete` lists why the comparison is not complete (a table without a rule, a migration
 * applied between the two whose effect is not declared). Prints no value, only fingerprints.
 */
export function compareDatabases(
  wasTables,
  nowTables,
  {
    rules: ruleSet = RULES,
    migrations = MIGRATIONS,
    key = randomBytes(32),
    sequences = [{}, {}],
  } = {},
) {
  // Names read from a database never reach an inherited member of these maps.
  const [was, now, rules] = [bareCopy(wasTables), bareCopy(nowTables), bareCopy(ruleSet)];
  const fp = (text) => createHmac('sha256', key).update(text).digest('hex').slice(0, 8);
  const versions = (db) =>
    new Set(db.schema_migrations ? objects(db.schema_migrations).map((r) => r.version) : []);
  const [old, current] = [versions(was), versions(now)];
  const applied = new Set([...current].filter((v) => !old.has(v)));
  const lines = [
    `Migrations applied between the two: ${applied.size ? [...applied].sort().join(', ') : 'none'}`,
  ];
  const undeclared = [...applied].sort().filter((v) => !Object.hasOwn(migrations, v));
  // An undeclared migration may change the structure; the run is then not fully compared anyway.
  const structure = undeclared.length === 0;
  lines.push(
    structure
      ? 'Structure: compared (column types and nullability, keys and constraints, row-level security, policies, triggers, sequences)'
      : 'Structure: not compared (a migration without a declared expected change ran between the two: structure changes are expected and the run is not fully compared)',
  );
  const unruled = [];
  const absent = [];
  let differences = 0;
  const names = new Set([...Object.keys(was), ...Object.keys(now), ...Object.keys(rules)]);
  for (const name of [...names].sort()) {
    const rule = rules[name];
    const [a, b] = [was[name], now[name]];
    if (!a && !b) {
      absent.push(name);
      lines.push(`${name}: - -> -, in neither database`);
      continue;
    }
    if (!rule) {
      unruled.push(name);
      lines.push(`${name}: ${a ? a.rows.length : '-'} -> ${b ? b.rows.length : '-'}, no rule`);
      continue;
    }
    if (!b) {
      differences += 1;
      lines.push(`${name}: ${a.rows.length} -> -, table missing after`);
      continue;
    }
    if (!a) {
      const expected = rule.addedIn && applied.has(rule.addedIn);
      if (!expected) differences += 1;
      lines.push(
        `${name}: - -> ${b.rows.length}, new table${expected ? ` (${rule.addedIn})` : ''}`,
      );
      continue;
    }
    const { line, problems } = compareTable(name, rule, a, b, applied, fp);
    differences += problems.length;
    if (problems.length === 1) lines.push(`${line}, ${problems[0]}`);
    else if (problems.length === 0) lines.push(line);
    else {
      lines.push(`${line}, ${plural(problems.length, 'difference')}:`);
      for (const problem of problems.slice(0, LISTED)) lines.push(`  ${problem}`);
      if (problems.length > LISTED) lines.push(`  … and ${problems.length - LISTED} more`);
    }
    if (!structure) continue;
    const changed = structureProblems(a.structure, b.structure);
    differences += changed.length;
    for (const problem of changed) lines.push(`${name}: structure differs: ${problem}`);
  }
  if (structure) {
    const [before, after] = sequences;
    const changed = [];
    for (const [name, value] of Object.entries(before))
      if (!Object.hasOwn(after, name)) changed.push(`sequence ${name}: missing after`);
      else if (lower(value, after[name])) changed.push(`sequence ${name}: last value decreased`);
    for (const name of Object.keys(after))
      if (!Object.hasOwn(before, name)) changed.push(`sequence ${name}: new`);
    differences += changed.length;
    lines.push(
      `Sequences: ${Object.keys(before).length} -> ${Object.keys(after).length}${changed.length ? '' : ', none decreased'}`,
      ...changed,
    );
  }
  const both = (list, one, many) =>
    `${list.length === 1 ? 'table' : 'tables'} ${list.join(', ')} ${list.length === 1 ? one : many}`;
  const incomplete = [
    ...(unruled.length ? [both(unruled, 'has no rule', 'have no rule')] : []),
    ...(absent.length ? [both(absent, 'is in neither database', 'are in neither database')] : []),
    ...undeclared.map(
      (v) => `migration ${v} ran between the two and declares no expected change here`,
    ),
  ];
  return { lines, differences, incomplete };
}

/** The verdict line and exit code of a comparison. */
export function verdict({ differences, incomplete }) {
  const partial = incomplete.length ? `not fully compared (${incomplete.join('; ')})` : '';
  if (!differences && !partial) return { line: 'RESULT: no difference', code: 0 };
  if (!differences) return { line: `RESULT: ${partial}`, code: 1 };
  return {
    line: `RESULT: ${plural(differences, 'difference')}${partial ? `; ${partial}` : ''}`,
    code: 1,
  };
}

/** Why a run stopped, without any text PGlite or SQL could carry. */
export function safeReason(error) {
  if (error instanceof Refusal) return error.message;
  if (error instanceof Interrupted) return 'interrupted';
  const code = typeof error?.code === 'string' ? error.code : '';
  // Errno codes first: EFBIG, EPERM, EBUSY and EROFS also look like a five-character SQLSTATE.
  const errno =
    /^E[A-Z0-9]+$/.test(code) &&
    (typeof error.errno === 'number' ||
      typeof error.syscall === 'string' ||
      Object.hasOwn(constants.errno, code));
  if (errno) return `file system error ${code}${error.syscall ? ` (${error.syscall})` : ''}`;
  if (/^[0-9A-Z]{5}$/.test(code)) return `the database could not be read (SQLSTATE ${code})`;
  return `unexpected ${error?.name ?? 'error'}`;
}

async function openAndRead(PGlite, dir) {
  const db = new PGlite(dir);
  try {
    await db.waitReady;
    return await readDatabase(db);
  } finally {
    await db.close().catch(() => {});
  }
}

class Interrupted extends Error {}

// Set by Ctrl+C (SIGINT), SIGTERM or a closed terminal (SIGHUP).
const STOP = { requested: false, work: null };

/**
 * A signal only asks the run to stop. The run itself removes its copies, once the step in flight
 * has ended: removing them from the handler raced the copy still being written, which left part
 * of a database behind. So the answer to Ctrl+C can take as long as copying one database.
 */
function onInterrupt() {
  STOP.requested = true;
  console.error(
    STOP.work
      ? `Interrupted: removing the scratch copy ${STOP.work}; wait for the RESULT line. If this window is closed first, delete that folder.`
      : 'Interrupted: stopping.',
  );
}

/**
 * The whole run. Returns `{ lines, code }`. `probes` (tests): `answers(port)`, `statfs`, and
 * `copied()`, called once both copies exist.
 */
export async function runTables(options, probes = {}) {
  const {
    answers = portAnswers,
    statfs: fs = statfs,
    copied = async () => {},
    cp: copy = cp,
    stop = STOP,
  } = probes;
  const checkpoint = () => {
    if (stop.requested) throw new Interrupted('interrupted');
  };
  if (!options.before || !options.after) refuse('--before and --after are required');
  const port = Number(options.port ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) refuse('invalid --port');
  const before = await checkInput('--before', resolve(options.before));
  const after = await checkInput('--after', resolve(options.after));
  if (before.real === after.real) refuse('--before and --after are the same folder');
  if (inside(before.real, after.real) || inside(after.real, before.real))
    refuse('--before and --after are inside one another');
  const scratch = await realpath(resolve(options.scratch ?? tmpdir())).catch(() =>
    refuse(`--scratch ${options.scratch} does not exist`),
  );
  if (!(await stat(scratch)).isDirectory()) refuse(`--scratch ${scratch} is not a folder`);
  for (const input of [before, after])
    if (inside(input.real, scratch))
      refuse(`--scratch ${scratch} is inside an input folder; pick a folder outside both`);
  const app = options.app ? resolve(options.app) : null;
  const inputs = [
    { label: '--before', ...before },
    { label: '--after', ...after },
  ];
  await checkStopped(inputs, { app, port, answers });
  await checkRoom(scratch, before.bytes + after.bytes + 2 * OPEN_MARGIN, fs);
  const PGlite = await loadPGlite(app);
  // What is read (and so proved unchanged) is the database folder of each input.
  const databaseOf = (input) => join(input.real, 'pglite');
  const digests = [await treeDigest(databaseOf(before)), await treeDigest(databaseOf(after))];
  checkpoint();
  const work = await mkdtemp(join(scratch, 'sipges-tables-'));
  stop.work = work;
  const databases = [];
  let failure = null;
  try {
    const copies = [join(work, 'before'), join(work, 'after')];
    for (const [i, input] of inputs.entries()) {
      checkpoint();
      await copy(databaseOf(input), copies[i], {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
      checkpoint();
      if ((await treeDigest(copies[i])) !== digests[i])
        refuse(`the copy of ${input.label} differs from it`);
    }
    await copied();
    for (const dir of copies) {
      checkpoint();
      databases.push(await openAndRead(PGlite, dir));
    }
  } catch (error) {
    failure = error;
  }
  // Nothing of this run is still writing under `work` here: every step above was awaited.
  const removal = await rm(work, { recursive: true, force: true, maxRetries: 5 }).then(
    () => null,
    (error) => error,
  );
  const left = await lstat(work).then(
    () => true,
    () => false,
  );
  if (left)
    refuse(
      `the scratch copy ${work} could not be removed (${removal ? safeReason(removal) : 'still there'}): delete that folder`,
    );
  stop.work = null;
  if (failure) throw failure;
  checkpoint();
  if (
    (await treeDigest(databaseOf(before))) !== digests[0] ||
    (await treeDigest(databaseOf(after))) !== digests[1]
  )
    return {
      lines: ['RESULT: not compared (an input folder changed during the run)'],
      code: NOT_COMPARED_EXIT,
    };
  const result = compareDatabases(databases[0].tables, databases[1].tables, {
    sequences: [databases[0].sequences, databases[1].sequences],
  });
  const { line, code } = verdict(result);
  return { lines: [...result.lines, line], code };
}

const USAGE = `Usage: node deploy/desktop/migration/tables.mjs --before <folder> --after <folder>
       [--app <install root>] [--scratch <folder>] [--port 8000]

Compares, table by table and column by column, the database of the state folder before the
migration (the launcher's <state>.pre-update-<time>-first-start-<version> copy) with the migrated
state folder, SIPGES closed, and the structure of each table and the sequences. Only each pglite
database folder is copied under --scratch (default the temp folder) and only the copies are
opened, then removed, also on Ctrl+C (after the copy in flight ends); each database folder is hashed before and after and must
not change. PGlite comes from the managed install given with --app (its current version), else from
this checkout. Refuses (exit 2, nothing copied) a link or junction, a folder holding one, the
same folder twice, --scratch inside an input or without room for both copies, SIPGES answering
on --port, a database opened in the last 2 minutes, an update running. Prints counts, table
and column names and 8-hex fingerprints keyed per run, never a value. Exit 0: no difference;
1: a difference or not fully compared; 2: not compared.`;

const OPTIONS = {
  '--before': 'before',
  '--after': 'after',
  '--app': 'app',
  '--scratch': 'scratch',
  '--port': 'port',
};

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(USAGE);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onInterrupt);
  try {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const name = OPTIONS[args[i]];
      if (!name || args[i + 1] === undefined || name in options)
        refuse(`invalid option ${args[i]}; use --help`);
      options[name] = args[i + 1];
    }
    const { lines, code } = await runTables(options);
    for (const line of lines) console.log(line);
    process.exitCode = code;
  } catch (error) {
    const reason = safeReason(error);
    console.error(`Error: ${reason}`);
    console.log(`RESULT: not compared (${reason})`);
    process.exitCode = NOT_COMPARED_EXIT;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
