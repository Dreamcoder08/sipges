// Snapshot of a running SIPGES through its public HTTP API, for the data move to the managed
// version (closure-roadmap T33). Safe on real data: the file and the output hold only counts and
// keyed hashes (HMAC-SHA256 with a random salt kept in the file), never a record, a name, a file
// or a file's plain SHA-256. Read deploy/desktop/migration/README.md.
//
//   node deploy/desktop/migration/snapshot.mjs --url http://127.0.0.1:8000 --out <file.json>
//        [--user admin] [--password-file <file>] [--otp <code>]
/* global AbortController */
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import {
  MODULE_SLUGS,
  credentials,
  getJson,
  keyed,
  keyedBytes,
  parseArgs,
  short,
  signIn,
} from './client.mjs';

export const FORMAT = 'sipges.migration-snapshot';
// 2: values hashed with their JSON type; every upload and audit entry, or marked incomplete.
// 3: upload contents keyed like every other value; records read to an empty page and checked
// against the export, or marked incomplete.
export const FORMAT_VERSION = 3;
const PAGE = 500;
// A list longer than this many pages is not read further (and marked incomplete).
const MAX_PAGES = 10_000;
const AUDIT_PAGE = 500;
// The upload list answers at most this many; the rest come from the export's attachment rows.
const UPLOAD_LIST_CAP = 500;
// Tables of the project export (GET /system/export) compared above record by record and entry
// by entry; every other exported table is compared as a set of row hashes.
const EXPORT_COMPARED_ELSEWHERE = new Set(['module_records', 'audit']);
const STREAM_TIMEOUT_MS = 120_000;

const failed = (what, status) => new Error(`${what} answered ${status}`);

/** The keyed hash of a record's own fields, as a list row or a single record returns them. */
const OWN = (entry) => entry[0] !== '_id' && entry[0] !== '_updated_at';
export const contentHash = (h, row) =>
  h(
    Object.entries(row)
      .filter(OWN)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );

/**
 * Every row of one module, page by page: `{ rows, problem }`, or null when this version has no
 * such module. A page may hold fewer rows than asked (a version with a lower cap), so the next
 * offset is the number read so far and only an empty page ends the list. A page that repeats a
 * row already read means the offset is not honoured: the list stops there and `problem` says
 * why it is not fully checked.
 */
async function moduleRows(session, scope, slug) {
  const rows = [];
  const seen = new Set();
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const offset = rows.length;
    const page = await getJson(session, `/api/${slug}?limit=${PAGE}&offset=${offset}`, scope);
    if (page.status === 404 && offset === 0) return null;
    if (page.status !== 200) throw failed(`/api/${slug}`, page.status);
    if (page.body.length === 0) return { rows, problem: null };
    for (const row of page.body) {
      const id = String(row._id);
      if (seen.has(id))
        return { rows, problem: `${slug}: the list repeated rows, its offset is not honoured` };
      seen.add(id);
      rows.push(row);
    }
  }
  return { rows, problem: `${slug}: more than ${MAX_PAGES} pages` };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The export's stored records not read through any list (a module this script does not know,
 * or a list that stopped early); null when the export cannot be read. By id when its rows carry
 * one, otherwise by count.
 */
function unreadExportRecords(exported, ids) {
  const stored = exported?.module_records;
  if (!Array.isArray(stored)) return null;
  const read = Object.values(ids).flat();
  if (stored.some((row) => row?.id === undefined || row?.id === null))
    return Math.max(0, stored.length - read.length);
  const left = new Map();
  for (const id of read) left.set(id, (left.get(id) ?? 0) + 1);
  let unread = 0;
  for (const row of stored) {
    const n = left.get(String(row.id)) ?? 0;
    if (n > 0) left.set(String(row.id), n - 1);
    else unread += 1;
  }
  return unread;
}

/**
 * Ids, modules and actions of the whole audit trail of a project, oldest first, from the activity
 * stream: only when the export cannot be read. It carries no detail, so its entries are counted
 * but their content is not checked.
 */
async function streamedTrail(session, scope, newest) {
  // One page shows the newest 500; the activity stream replays the rest from the start (module
  // and action only), so the count and every id are exact.
  const lastId = newest[0].id;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  const entries = [];
  try {
    const response = await session.call('/system/events', {
      scope,
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': '0' },
      signal: controller.signal,
    });
    if (response.status !== 200) throw failed('/system/events', response.status);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const field = (name) =>
          block
            .split('\n')
            .find((line) => line.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim();
        if (field('event') !== 'activity') continue;
        const id = Number(field('id'));
        const data = JSON.parse(field('data') ?? '{}');
        entries.push({ id, module: data.module, action: data.action });
        if (id >= lastId) return entries;
      }
    }
  } catch (error) {
    if (error.name === 'AbortError')
      throw new Error('The audit stream did not reach the newest entry in time', { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  throw new Error('The audit stream ended before the newest entry');
}

/**
 * Every audit entry with its full content: the export's rows, or the newest page when it holds
 * the whole trail. Otherwise the streamed ids, marked incomplete (their content is not checked).
 */
async function auditOf(session, scope, h, exported) {
  const byId = (a, b) => Number(a.id) - Number(b.id);
  if (Array.isArray(exported?.audit)) {
    const rows = [...exported.audit].sort(byId);
    return { source: 'export', complete: true, rows, hash: (row) => h(row) };
  }
  const newest = await getJson(session, `/system/audit?limit=${AUDIT_PAGE}`, scope);
  if (newest.status !== 200) throw failed('/system/audit', newest.status);
  if (newest.body.length < AUDIT_PAGE)
    return { source: 'audit', complete: true, rows: [...newest.body].sort(byId), hash: h };
  const rows = await streamedTrail(session, scope, newest.body);
  return { source: 'stream', complete: false, rows, hash: (e) => h(`${e.module}\n${e.action}`) };
}

/**
 * The id of every upload: the list shows at most 500, so the export's attachment rows name the
 * rest. Without the export a full list is marked incomplete: the rest cannot be checked.
 */
async function uploadIdsOf(session, scope, exported) {
  const listed = await getJson(session, `/system/uploads?limit=${UPLOAD_LIST_CAP}`, scope);
  if (listed.status !== 200) throw failed('/system/uploads', listed.status);
  const ids = new Set(listed.body.map((upload) => String(upload.id)));
  if (Array.isArray(exported?.attachments)) {
    for (const row of exported.attachments) ids.add(String(row.id));
    return { ids: [...ids].sort(), complete: true };
  }
  return { ids: [...ids].sort(), complete: listed.body.length < UPLOAD_LIST_CAP };
}

/**
 * Reads everything the comparison needs. Returns `{ snapshot, live }`: `snapshot` holds only
 * counts and keyed hashes; `live` keeps the raw ids, modules and actions in memory for the
 * isolation probes and the list of added audit entries, and is never written.
 */
export async function takeSnapshot(session, { salt = randomBytes(16).toString('hex') } = {}) {
  const h = keyed(salt);
  const hb = keyedBytes(salt);
  const scopes = await getJson(session, '/system/auth/scopes');
  if (scopes.status !== 200) throw failed('/system/auth/scopes', scopes.status);
  const names = scopes.body.map((s) => `${s.company_id}/${s.project_id}`).sort();
  const snapshot = {
    format: FORMAT,
    version: FORMAT_VERSION,
    takenAt: new Date().toISOString(),
    salt,
  };
  const live = { projects: {} };
  snapshot.projects = [];
  for (const scope of names) {
    const project = { key: h(scope), modules: {}, links: {}, uploads: {}, audit: {} };
    const ids = {};
    const contents = {};
    const unchecked = [];
    for (const slug of MODULE_SLUGS) {
      const listed = await moduleRows(session, scope, slug);
      if (listed === null) continue;
      const { rows, problem } = listed;
      if (problem) unchecked.push(problem);
      ids[slug] = rows.map((row) => String(row._id));
      contents[slug] = Object.fromEntries(
        rows.map((row) => [String(row._id), contentHash(h, row)]),
      );
      project.modules[slug] = Object.fromEntries(
        rows.map((row) => {
          const { _id, _updated_at, ...fields } = row;
          return [
            h(String(_id)),
            {
              updated: h(String(_updated_at ?? '')),
              fields: Object.fromEntries(
                Object.entries(fields).map(([name, value]) => [h(name), h(value ?? null)]),
              ),
            },
          ];
        }),
      );
    }
    for (const [slug, list] of Object.entries(ids))
      for (const id of list) {
        const found = await getJson(
          session,
          `/system/links?module=${encodeURIComponent(slug)}&id=${encodeURIComponent(id)}`,
          scope,
        );
        if (found.status !== 200) throw failed('/system/links', found.status);
        for (const link of found.body.links ?? [])
          project.links[h(String(link.edge.id))] = h(link.edge);
      }
    const exportedAnswer = await getJson(session, '/system/export', scope);
    const exported = exportedAnswer.status === 200 ? (exportedAnswer.body.data ?? {}) : null;
    project.export = exported
      ? Object.fromEntries(
          Object.entries(exported)
            .filter(([table]) => !EXPORT_COMPARED_ELSEWHERE.has(table))
            .map(([table, rows]) => [table, rows.map((row) => h(row)).sort()]),
        )
      : null;
    // The export proves the lists complete when every stored record was read; then a list that
    // could not prove its own end is complete all the same. Otherwise both reasons are kept.
    const unread = unreadExportRecords(exported, ids);
    if (unread)
      unchecked.push(
        `${plural(unread, 'record')} in the project export not read through the lists`,
      );
    project.recordsUnchecked = unread === 0 ? [] : unchecked;
    // Every upload by its id: metadata and the downloaded content's SHA-256.
    const { ids: uploadIds, complete: uploadsComplete } = await uploadIdsOf(
      session,
      scope,
      exported,
    );
    project.uploadsComplete = uploadsComplete;
    for (const id of uploadIds) {
      const path = `/system/uploads/${encodeURIComponent(id)}`;
      const upload = await getJson(session, path, scope);
      if (upload.status !== 200) throw failed('an upload', upload.status);
      const file = await session.call(`${path}/download`, { scope });
      if (file.status !== 200) throw failed('an upload download', file.status);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const meta = Object.fromEntries(
        Object.entries(upload.body).filter(([k]) => k !== 'download_url'),
      );
      project.uploads[h(id)] = { content: hb(bytes), meta: h(meta) };
    }
    const audit = await auditOf(session, scope, h, exported);
    project.audit = {
      source: audit.source,
      complete: audit.complete,
      entries: Object.fromEntries(audit.rows.map((row) => [String(row.id), audit.hash(row)])),
    };
    const trail = audit.rows.map((row) => ({ id: row.id, module: row.module, action: row.action }));
    snapshot.projects.push(project);
    live.projects[project.key] = { scope, ids, contents, uploadIds, audit: trail, hash: h };
  }
  const first = names[0];
  const accounts = first ? await getJson(session, '/system/auth/accounts', first) : { status: 0 };
  snapshot.accounts =
    accounts.status === 200
      ? Object.fromEntries(accounts.body.map((a) => [h(String(a.username)), h(a)]))
      : null;
  return { snapshot, live };
}

export const recordCount = (project) =>
  Object.values(project.modules).reduce((sum, rows) => sum + Object.keys(rows).length, 0);

/** The lines both scripts print for a snapshot: counts and short keyed hashes only. */
export function summary(snapshot) {
  const lines = [`Projects: ${snapshot.projects.length}`];
  snapshot.projects.forEach((project, index) => {
    const modules = Object.entries(project.modules)
      .map(([slug, rows]) => [slug, Object.keys(rows).length])
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([slug, count]) => `${slug} ${count}`);
    lines.push(
      `project ${index + 1} [${short(project.key)}]: records ${recordCount(project)}${
        modules.length ? ` (${modules.join(', ')})` : ''
      }${project.recordsUnchecked.length ? ' (not fully checked)' : ''}, links ${Object.keys(project.links).length}, uploads ${
        Object.keys(project.uploads).length
      }${project.uploadsComplete ? '' : ' (not fully checked)'}, audit ${
        Object.keys(project.audit.entries).length
      }${project.audit.complete ? '' : ' (not fully checked)'}`,
    );
  });
  lines.push(
    `Accounts: ${snapshot.accounts ? Object.keys(snapshot.accounts).length : 'not readable'}`,
  );
  return lines;
}

const USAGE = `Usage: node deploy/desktop/migration/snapshot.mjs --url <base> --out <file.json>
       [--user admin] [--password-file <file>] [--otp <code> | --totp-secret-file <file> [--totp-state <file>]]

Signs in as an administrator and writes counts and keyed hashes of every project the account can
open: records per module (each field hashed; every list read to its end and checked against the
project export), links, uploads (content hashed with the same key), the audit trail and the
accounts. Prints counts and short hashes only. Without --password-file the password comes
from SIPGES_MIGRATION_PASSWORD or a prompt; without --otp the MFA code is asked for.`;

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(USAGE);
  const options = parseArgs(args, [
    '--url',
    '--out',
    '--user',
    '--password-file',
    '--otp',
    '--totp-secret-file',
    '--totp-state',
  ]);
  if (!options['--url'] || !options['--out']) throw new Error('--url and --out are required');
  const session = await signIn(await credentials(options));
  const { snapshot } = await takeSnapshot(session);
  const out = resolve(options['--out']);
  await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`SIPGES snapshot at ${snapshot.takenAt}`);
  for (const line of summary(snapshot)) console.log(line);
  console.log(`Written: ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
