// Snapshot of a running SIPGES through its public HTTP API, for the data move to the managed
// version (closure-roadmap T33). Safe on real data: the file and the output hold only counts and
// keyed hashes (HMAC-SHA256 with a random salt kept in the file), never a record, a name or a
// file. Read deploy/desktop/migration/README.md.
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
  parseArgs,
  sha256,
  short,
  signIn,
} from './client.mjs';

export const FORMAT = 'sipges.migration-snapshot';
const PAGE = 500;
const AUDIT_PAGE = 500;
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

/** Every row of one module, page by page; null when this version has no such module. */
async function moduleRows(session, scope, slug) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await getJson(session, `/api/${slug}?limit=${PAGE}&offset=${offset}`, scope);
    if (page.status === 404 && offset === 0) return null;
    if (page.status !== 200) throw failed(`/api/${slug}`, page.status);
    rows.push(...page.body);
    if (page.body.length < PAGE) return rows;
  }
}

/** Ids, modules and actions of the whole audit trail of a project, oldest first. */
async function auditTrail(session, scope, newest) {
  if (newest.length < AUDIT_PAGE) return [...newest].reverse();
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
 * Reads everything the comparison needs. Returns `{ snapshot, live }`: `snapshot` holds only
 * counts and keyed hashes; `live` keeps the raw ids, modules and actions in memory for the
 * isolation probes and the list of added audit entries, and is never written.
 */
export async function takeSnapshot(session, { salt = randomBytes(16).toString('hex') } = {}) {
  const h = keyed(salt);
  const scopes = await getJson(session, '/system/auth/scopes');
  if (scopes.status !== 200) throw failed('/system/auth/scopes', scopes.status);
  const names = scopes.body.map((s) => `${s.company_id}/${s.project_id}`).sort();
  const snapshot = { format: FORMAT, version: 1, takenAt: new Date().toISOString(), salt };
  const live = { projects: {} };
  snapshot.projects = [];
  for (const scope of names) {
    const project = { key: h(scope), modules: {}, links: {}, uploads: {}, audit: {} };
    const ids = {};
    const contents = {};
    for (const slug of MODULE_SLUGS) {
      const rows = await moduleRows(session, scope, slug);
      if (rows === null) continue;
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
    const uploads = await getJson(session, `/system/uploads?limit=${PAGE}`, scope);
    if (uploads.status !== 200) throw failed('/system/uploads', uploads.status);
    project.uploadsCapped = uploads.body.length >= PAGE;
    const uploadIds = [];
    for (const upload of uploads.body) {
      const file = await session.call(`/system/uploads/${encodeURIComponent(upload.id)}/download`, {
        scope,
      });
      if (file.status !== 200) throw failed('an upload download', file.status);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const meta = Object.fromEntries(Object.entries(upload).filter(([k]) => k !== 'download_url'));
      project.uploads[h(String(upload.id))] = { sha256: sha256(bytes), meta: h(meta) };
      uploadIds.push(String(upload.id));
    }
    const exported = await getJson(session, '/system/export', scope);
    project.export =
      exported.status === 200
        ? Object.fromEntries(
            Object.entries(exported.body.data ?? {})
              .filter(([table]) => !EXPORT_COMPARED_ELSEWHERE.has(table))
              .map(([table, rows]) => [table, rows.map((row) => h(row)).sort()]),
          )
        : null;
    const newest = await getJson(session, `/system/audit?limit=${AUDIT_PAGE}`, scope);
    if (newest.status !== 200) throw failed('/system/audit', newest.status);
    const trail = await auditTrail(session, scope, newest.body);
    project.audit = {
      entries: Object.fromEntries(trail.map((e) => [String(e.id), h(`${e.module}\n${e.action}`)])),
      latest: Object.fromEntries(newest.body.map((e) => [String(e.id), h(e)])),
    };
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
      }, links ${Object.keys(project.links).length}, uploads ${
        Object.keys(project.uploads).length
      }${project.uploadsCapped ? ' (list capped at 500)' : ''}, audit ${
        Object.keys(project.audit.entries).length
      }`,
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
open: records per module (each field hashed), links, uploads (content SHA-256), the audit trail
and the accounts. Prints counts and short hashes only. Without --password-file the password comes
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
