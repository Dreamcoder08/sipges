// Compares a running SIPGES with a snapshot taken before the data move (closure-roadmap T33),
// through the public HTTP API. Safe on real data: it prints counts, short keyed hashes, audit ids
// with their module and action, and probe counts; never a record, a name or a file.
// Exit code 0: no difference (audit entries added since the snapshot are listed, not counted);
// 1: a difference, a part that could not be fully checked (each one printed), a failed sign-in
// or an error. Read deploy/desktop/migration/README.md.
//
//   node deploy/desktop/migration/compare.mjs --before <snapshot.json> --url http://127.0.0.1:8000
//        [--user admin] [--password-file <file>] [--otp <code>] [--out <after.json>]
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { SignInError, credentials, keyed, parseArgs, short, signIn } from './client.mjs';
import { FORMAT, FORMAT_VERSION, contentHash, takeSnapshot } from './snapshot.mjs';

const LISTED = 20;
const DEFAULT_PROBES = 25;

const count = (map) => Object.keys(map ?? {}).length;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Problems between two maps of keyed hashes: missing, new and changed keys. */
function mapProblems(before = {}, after = {}, noun, changed = 'differs') {
  const problems = [];
  for (const key of Object.keys(before).sort())
    if (!(key in after)) problems.push(`${noun} [${short(key)}] missing`);
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      problems.push(`${noun} [${short(key)}] ${changed}`);
  for (const key of Object.keys(after).sort())
    if (!(key in before)) problems.push(`${noun} [${short(key)}] new`);
  return problems;
}

function recordProblems(before = {}, after = {}) {
  const problems = [];
  for (const key of Object.keys(before).sort()) {
    const [was, now] = [before[key], after[key]];
    if (!now) {
      problems.push(`record [${short(key)}] missing`);
      continue;
    }
    for (const problem of mapProblems(was.fields, now.fields, 'field'))
      problems.push(`record [${short(key)}] ${problem}`);
    if (was.updated !== now.updated) problems.push(`record [${short(key)}] update time differs`);
  }
  for (const key of Object.keys(after).sort())
    if (!(key in before)) problems.push(`record [${short(key)}] new`);
  return problems;
}

/** One line, or a line and the problems under it. */
function report(out, label, problems, okText) {
  if (problems.length === 0) return out.push(`  ${label}, ${okText}`);
  if (problems.length === 1) return out.push(`  ${label}, ${problems[0]}`);
  out.push(`  ${label}, ${plural(problems.length, 'problem')}:`);
  for (const problem of problems.slice(0, LISTED)) out.push(`    ${problem}`);
  if (problems.length > LISTED) out.push(`    … and ${problems.length - LISTED} more`);
}

function auditLine(out, before, after, liveTrail) {
  const kept = [];
  const missing = [];
  const changed = [];
  for (const [id, hash] of Object.entries(before.entries)) {
    if (!(id in after.entries)) missing.push(id);
    else if (after.entries[id] !== hash) changed.push(id);
    else kept.push(id);
  }
  const added = (liveTrail ?? []).filter((e) => !(String(e.id) in before.entries));
  const parts = [`${count(before.entries)} -> ${count(after.entries)}`];
  if (kept.length) parts.push(`${kept.length} kept unchanged`);
  if (missing.length) parts.push(`${missing.length} missing`);
  if (changed.length) parts.push(`${changed.length} changed`);
  if (added.length) {
    const named = added.slice(0, LISTED).map((e) => `#${e.id} ${e.module}/${e.action}`);
    if (added.length > LISTED) named.push(`… and ${added.length - LISTED} more`);
    parts.push(`added: ${named.join(', ')}`);
  }
  out.push(`  audit: ${parts.join(', ')}`);
  return { problems: missing.length + changed.length, added: added.length };
}

/**
 * Other exported tables, as sets of row hashes. Returns `{ differences, incomplete }`: an export
 * readable on neither side compares nothing, so it is printed and counted as not checked.
 */
function exportLines(out, before, after) {
  if (!before && !after) {
    out.push('  export: not checked (the project export is not readable on either side)');
    return { differences: 0, incomplete: 1 };
  }
  if (!before || !after) {
    out.push('  export: readable on one side only');
    return { differences: 1, incomplete: 0 };
  }
  let differences = 0;
  for (const table of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const [was, now] = [before[table] ?? [], after[table] ?? []];
    if (was.length === 0 && now.length === 0) continue;
    const left = [...now];
    let missing = 0;
    for (const hash of was) {
      const at = left.indexOf(hash);
      if (at < 0) missing += 1;
      else left.splice(at, 1);
    }
    const problems = [];
    if (missing) problems.push(`${plural(missing, 'row')} missing or changed`);
    if (left.length) problems.push(`${plural(left.length, 'row')} new or changed`);
    differences += problems.length ? 1 : 0;
    out.push(
      `  export ${table}: ${was.length} -> ${now.length}, ${problems.length ? problems.join(', ') : 'identical'}`,
    );
  }
  return { differences, incomplete: 0 };
}

/**
 * Compares two snapshots taken with the same salt. Returns `{ lines, differences, added,
 * incomplete }`: `incomplete` counts the parts that could not be checked in full (a record list
 * that did not end or that the export contradicts, more uploads than the list shows or an audit
 * trail past one page without the project export, an export or accounts readable on neither
 * side). Each is printed and none ever counts as identical.
 */
export function compareSnapshots(before, after, live = { projects: {} }) {
  const out = [];
  let differences = 0;
  let added = 0;
  let incomplete = 0;
  const afterByKey = new Map(after.projects.map((p) => [p.key, p]));
  before.projects.forEach((was, index) => {
    const now = afterByKey.get(was.key);
    out.push(`project ${index + 1} [${short(was.key)}]`);
    if (!now) {
      out.push('  missing after the move');
      differences += 1;
      return;
    }
    const slugs = [...new Set([...Object.keys(was.modules), ...Object.keys(now.modules)])].sort();
    for (const slug of slugs) {
      const [a, b] = [count(was.modules[slug]), count(now.modules[slug])];
      if (a === 0 && b === 0) continue;
      const problems = recordProblems(was.modules[slug], now.modules[slug]);
      differences += problems.length;
      report(out, `${slug}: ${a} -> ${b}`, problems, 'every field identical');
    }
    const unchecked = [...new Set([...was.recordsUnchecked, ...now.recordsUnchecked])];
    if (unchecked.length) {
      incomplete += 1;
      out.push(`  records: not fully checked (${unchecked.join('; ')})`);
    }
    const links = mapProblems(was.links, now.links, 'link');
    differences += links.length;
    report(out, `links: ${count(was.links)} -> ${count(now.links)}`, links, 'identical');
    const uploads = [];
    for (const key of Object.keys(was.uploads).sort()) {
      const [x, y] = [was.uploads[key], now.uploads[key]];
      if (!y) uploads.push(`upload [${short(key)}] missing`);
      else if (x.content !== y.content) uploads.push(`upload [${short(key)}] content differs`);
      else if (x.meta !== y.meta) uploads.push(`upload [${short(key)}] metadata differs`);
    }
    for (const key of Object.keys(now.uploads).sort())
      if (!(key in was.uploads)) uploads.push(`upload [${short(key)}] new`);
    if (!was.uploadsComplete || !now.uploadsComplete) {
      incomplete += 1;
      out.push(
        `  uploads: not fully checked (${count(was.uploads)} -> ${count(now.uploads)} read; more than the list shows and the project export is not readable)`,
      );
    }
    differences += uploads.length;
    // Keyed content hashes only: a known file's plain SHA-256 is never printed.
    const contents = keyed('00')(
      Object.values(was.uploads)
        .map((u) => u.content)
        .sort()
        .join('\n'),
    );
    const content = count(was.uploads) === 1 ? Object.values(was.uploads)[0].content : contents;
    if (was.uploadsComplete && now.uploadsComplete)
      report(
        out,
        `uploads: ${count(was.uploads)} -> ${count(now.uploads)}`,
        uploads,
        count(was.uploads) === 0 ? 'none' : `content ${content.slice(0, 12)}… identical`,
      );
    else for (const problem of uploads.slice(0, LISTED)) out.push(`    ${problem}`);
    const exported = exportLines(out, was.export, now.export);
    differences += exported.differences;
    incomplete += exported.incomplete;
    if (!was.audit.complete || !now.audit.complete || was.audit.source !== now.audit.source) {
      // Streamed entries carry no detail, and two sources hash different shapes.
      incomplete += 1;
      out.push(
        `  audit: not fully checked (${count(was.audit.entries)} -> ${count(now.audit.entries)} entries; more than one page and the project export is not readable)`,
      );
    } else {
      const audit = auditLine(out, was.audit, now.audit, live.projects[now.key]?.audit);
      differences += audit.problems;
      added += audit.added;
    }
  });
  for (const project of after.projects)
    if (!before.projects.some((p) => p.key === project.key)) {
      out.push(`project [${short(project.key)}] new after the move`);
      differences += 1;
    }
  if (before.accounts && after.accounts) {
    const accounts = mapProblems(before.accounts, after.accounts, 'account');
    differences += accounts.length;
    const label = `Accounts: ${count(before.accounts)} -> ${count(after.accounts)}`;
    if (accounts.length === 0) out.push(`${label}, identical`);
    else for (const problem of [label, ...accounts]) out.push(problem);
  } else if (before.accounts || after.accounts) {
    out.push('Accounts: readable on one side only');
    differences += 1;
  } else {
    out.push('Accounts: not checked (not readable on either side)');
    incomplete += 1;
  }
  return { lines: out, differences, added, incomplete };
}

/**
 * Asks every other project for each record and upload of a project (at most `limit` per module
 * and project). A record found there is a leak unless that project lists the same id itself
 * with the same content as the answer (two projects may each have their own record of an id).
 */
export async function probeIsolation(session, live, limit = DEFAULT_PROBES) {
  const projects = Object.values(live.projects);
  let probes = 0;
  const leaks = { records: 0, uploads: 0 };
  for (const from of projects)
    for (const other of projects) {
      if (other === from) continue;
      for (const [slug, ids] of Object.entries(from.ids))
        for (const id of ids.slice(0, limit)) {
          probes += 1;
          const response = await session.call(`/api/${slug}/${encodeURIComponent(id)}`, {
            scope: other.scope,
          });
          const body =
            response.status === 200 ? await response.json() : await response.arrayBuffer();
          if (response.status === 200) {
            const own = other.contents[slug]?.[id];
            if (own === undefined || own !== contentHash(other.hash, body)) leaks.records += 1;
          } else if (response.status !== 404)
            throw new Error(`An isolation probe answered ${response.status}`);
        }
      for (const id of from.uploadIds.slice(0, limit)) {
        probes += 1;
        const response = await session.call(`/system/uploads/${encodeURIComponent(id)}/download`, {
          scope: other.scope,
        });
        await response.arrayBuffer();
        if (response.status === 200 && !other.uploadIds.includes(id)) leaks.uploads += 1;
        else if (![200, 404].includes(response.status))
          throw new Error(`An isolation probe answered ${response.status}`);
      }
    }
  return { probes, leaks };
}

const USAGE = `Usage: node deploy/desktop/migration/compare.mjs --before <snapshot.json> --url <base>
       [--user admin] [--password-file <file>] [--otp <code> | --totp-secret-file <file> [--totp-state <file>]]
       [--probe-limit 25] [--out <after.json>]

Signs in (the same password and MFA as before the move), takes the same snapshot with the salt of
--before and prints, per project and module, the counts before and after and whether every field,
link, upload (SHA-256) and audit entry is unchanged; audit entries added since are listed by id,
module and action. Then probes that no record or upload of one project opens in another.
Every record list is read to its end and checked against the project export, every upload is
read by its id (the export names those past the 500 the list shows) and every audit entry with
its content (from the export); a part that cannot be read in full is printed as "not fully
checked" (or "not checked") and fails the comparison, as does a snapshot of an older format.
Prints counts and short keyed hashes only. Exit code 0 when nothing differs and everything was
checked, otherwise 1.`;

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(USAGE);
  const options = parseArgs(args, [
    '--before',
    '--url',
    '--user',
    '--password-file',
    '--otp',
    '--totp-secret-file',
    '--totp-state',
    '--probe-limit',
    '--out',
  ]);
  if (!options['--before'] || !options['--url']) throw new Error('--before and --url are required');
  const before = JSON.parse(await readFile(options['--before'], 'utf8'));
  if (before.format !== FORMAT || typeof before.salt !== 'string')
    throw new Error(`${options['--before']} is not a snapshot made by snapshot.mjs`);
  if (before.version !== FORMAT_VERSION)
    throw new Error(
      `${options['--before']} was made by an older snapshot.mjs; take it again with this one before the move`,
    );
  const limit =
    options['--probe-limit'] === undefined ? DEFAULT_PROBES : Number(options['--probe-limit']);
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Invalid --probe-limit');
  let session;
  try {
    session = await signIn(await credentials(options));
  } catch (error) {
    if (!(error instanceof SignInError)) throw error;
    console.log(error.message);
    console.log('RESULT: sign-in failed');
    process.exitCode = 1;
    return;
  }
  console.log(`Sign-in: ok (${session.withCode ? 'password and MFA code' : 'password'})`);
  const { snapshot: after, live } = await takeSnapshot(session, { salt: before.salt });
  if (options['--out'])
    await writeFile(resolve(options['--out']), `${JSON.stringify(after, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  const result = compareSnapshots(before, after, live);
  for (const line of result.lines) console.log(line);
  const isolation = await probeIsolation(session, live, limit);
  const leaked = isolation.leaks.records + isolation.leaks.uploads;
  console.log(
    leaked === 0
      ? `Isolation: ${isolation.probes} probes, no record or upload of one project visible in another`
      : `Isolation: ${isolation.probes} probes, ${leaked} visible in another project (records ${isolation.leaks.records}, uploads ${isolation.leaks.uploads})`,
  );
  const differences = result.differences + (leaked ? 1 : 0);
  const unchecked = result.incomplete
    ? `not fully checked (${plural(result.incomplete, 'part')}, listed above)`
    : '';
  if (differences === 0 && !unchecked)
    console.log(
      result.added
        ? `RESULT: no difference (${result.added} audit ${result.added === 1 ? 'entry' : 'entries'} added, listed above)`
        : 'RESULT: no difference',
    );
  else if (differences === 0) console.log(`RESULT: ${unchecked}`);
  else
    console.log(`RESULT: ${plural(differences, 'difference')}${unchecked ? `; ${unchecked}` : ''}`);
  process.exitCode = differences === 0 && !unchecked ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
