// deploy/desktop/migration/tables.mjs run for real, as a person runs it: its own process, its exit
// code and its lines. drill.mjs (step 6) runs it on the Windows runner with the drill's managed
// install (--app), from the scripts unpacked from the visit zip; tables-drill.test.mjs runs it
// with this checkout's PGlite (no --app) on any system. Synthetic state folders only, built the
// way deploy/desktop/migration/tables.test.mjs builds them: every migration of this checkout and
// a few rows holding a marker, so a printed value would show. Every folder is under
// <work>\tables, on the work folder's drive (NTFS on Windows, checked).
//
//   a. two identical folders: exit 0, last line `RESULT: no difference`;
//   b. one changed row: exit 1 and a `RESULT: N difference(s)` line;
//   c. an input that is a junction, and one that holds a junction: exit 2, `RESULT: not compared
//      (…)`;
//   d. --app given a folder that is no managed install: exit 2 (--app is used, never skipped);
//   e. something answering on --port (SIPGES open): exit 2.
// After every run the scratch folder is empty (nothing copied, or every copy removed) and the
// inputs are byte-identical to before. Never run here: an interrupt. Node's child.kill('SIGINT')
// on Windows ends the process outright, it delivers no signal; tables-interrupt.mjs sends a real
// console Ctrl+C instead.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { readCurrent } from '../updater/updater.mjs';
import { digest, tree } from '../migration/rehearse.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
export const TABLES = join(here, '..', 'migration', 'tables.mjs');
// Synthetic marker in every seeded value: no output of tables.mjs may hold it.
export const MARK = 'ZZSINTETICO';
const T = `SIPGES/${MARK}-ALFA`;
const D = '2026-01-01T00:00:00Z';
const SEED = `
INSERT INTO tenants (company_id, project_id, label) VALUES ('SIPGES', '${MARK}-ALFA', '${MARK} Alfa');
INSERT INTO users (username, full_name, password_hash, role, totp_secret_sealed, totp_enabled,
  totp_last_step, created_at) VALUES
  ('${MARK}-ana', '${MARK} Ana', '$scrypt$${MARK}-hash-ana', 'admin', 'v1.${MARK}-mfa-ana', true, 7, '${D}'),
  ('${MARK}-beto', '${MARK} Beto', '$scrypt$${MARK}-hash-beto', 'analista', 'v1.${MARK}-mfa-beto', true, 9, '${D}');
INSERT INTO grants (username, tenant_id, created_at) VALUES ('${MARK}-beto', '${T}', '${D}');
INSERT INTO module_records (tenant_id, module, id, payload, created_at, updated_at)
  VALUES ('${T}', 'eventos', '${MARK}-EV-1', '{"Titulo": "${MARK} reunión"}', '${D}', '${D}');
INSERT INTO audit (tenant_id, ts, module, action, detail)
  VALUES ('${T}', '${D}', 'eventos', 'create', '${MARK} uno');`;
// The one change of run b: a password hash, compared byte for byte.
const CHANGE = `UPDATE users SET password_hash = '$scrypt$${MARK}-otro' WHERE username = '${MARK}-beto'`;
const MIGRATIONS = join(repo, 'apps', 'api', 'src', 'platform', 'database', 'migrations');

/** What a run printed, as the drill shows it: the exit code, then stdout and stderr apart. */
export const report = ({ code, stdout, stderr }) =>
  `exit code ${code}\n--- stdout\n${stdout}${stdout.endsWith('\n') || !stdout ? '' : '\n'}--- stderr\n${stderr}${stderr.endsWith('\n') || !stderr ? '' : '\n'}--- end`;

/** The last non-empty line of a run's stdout. */
export const lastLine = (stdout) =>
  stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .at(-1) ?? '';

/** Runs tables.mjs in its own Node process; stdout and stderr kept apart. */
export async function runTool(script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let [stdout, stderr] = ['', ''];
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const [code, signal] = await once(child, 'close');
  return { code: code ?? `none (ended by ${signal})`, stdout, stderr };
}

/** A port nothing listens on: taken from the system, then released. */
export async function closedPort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

const inside = (parent, child) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
};

/** One Windows PowerShell 5.1 expression about a path (given through the environment). */
function powershell(expression, path) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'),
  );
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', expression],
    { encoding: 'utf8', env: { ...env, TABLES_DRILL_PATH: path }, windowsHide: true },
  );
  return (result.stdout ?? '').trim();
}

/** The file system of a folder's drive, as Windows names it (NTFS, FAT32, …). */
export const driveFormat = (path) =>
  powershell(
    '(New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot($env:TABLES_DRILL_PATH))).DriveFormat',
    path,
  );

/** What Windows calls a link (Junction, SymbolicLink), or nothing. */
export const linkType = (path) =>
  powershell('[string](Get-Item -LiteralPath $env:TABLES_DRILL_PATH -Force).LinkType', path);

/** A junction on Windows (no privilege needed); a symbolic link elsewhere. */
export const makeJunction = (target, path) => symlink(target, path, 'junction');

/** The PGlite entry file a package.json resolves, or null when it is not installed there. */
function resolvePGlite(packageJson) {
  try {
    return createRequire(packageJson).resolve('@electric-sql/pglite');
  } catch {
    return null;
  }
}

export async function checkoutPGlite() {
  const entry = resolvePGlite(join(repo, 'apps', 'api', 'package.json'));
  if (!entry) throw new Error('PGlite not found in apps/api: run pnpm install --frozen-lockfile');
  return (await import(pathToFileURL(entry).href)).PGlite;
}

/** A state folder: this checkout's migrations with synthetic rows, plus a state folder's files. */
export async function buildState(PGlite, dir) {
  await mkdir(join(dir, 'uploads'), { recursive: true });
  const db = new PGlite(join(dir, 'pglite'));
  try {
    await db.exec(
      'CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL)',
    );
    for (const file of (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(await readFile(join(MIGRATIONS, file), 'utf8'));
      await db.query('INSERT INTO schema_migrations VALUES ($1, $2)', [file.slice(0, 4), D]);
    }
    await db.exec(SEED);
  } finally {
    await db.close();
  }
  await writeFile(join(dir, 'data-key'), `${MARK}-data-key`);
  await writeFile(join(dir, 'admin-password'), `${MARK}-admin-password`);
  await writeFile(join(dir, 'uploads', 'acta.txt'), `${MARK} acta`);
  return dir;
}

async function changed(PGlite, from, to, sql) {
  await cp(from, to, { recursive: true, errorOnExist: true, force: false });
  const db = new PGlite(join(to, 'pglite'));
  try {
    await db.exec(sql);
  } finally {
    await db.close();
  }
  return to;
}

/**
 * The whole run. `app`: the managed install root to pass as --app, or null for this checkout's
 * PGlite. `script`: the tables.mjs to run. `say` and `check` print as the drill does; `log(name)`
 * names the file each run's report is written to. Returns `{ pglite: 'managed' | 'checkout' }`.
 */
export async function tablesDrill({
  work,
  app = null,
  script = TABLES,
  say,
  check,
  log = null,
  platform = process.platform,
  junction = makeJunction,
  windowsLinkType = linkType,
  fileSystem = driveFormat,
}) {
  const dir = join(work, 'tables');
  const scratch = join(dir, 'scratch');
  await mkdir(scratch, { recursive: true });
  if (platform === 'win32') {
    const format = fileSystem(dir);
    check(format === 'NTFS', `the drive of ${dir} is NTFS (${format || 'not read'})`);
  } else say(`not Windows (${platform}): the file system is not checked`);

  let appArgs = [];
  let pglite = 'checkout';
  if (app) {
    const current = await readCurrent(app).catch(() => null);
    check(Boolean(current), `${app} is a managed install root (current.json)`);
    const entry = resolvePGlite(join(current.dir, 'api', 'package.json'));
    check(
      Boolean(entry) && inside(realpathSync.native(app), realpathSync.native(entry)),
      `the managed install ${current.version} holds its own PGlite (${entry ?? 'not found'})`,
    );
    appArgs = ['--app', app];
    pglite = 'managed';
    say(`PGlite exercised: the managed install's (--app ${app}, version ${current.version})`);
  } else say("PGlite exercised: this checkout's (apps/api, no --app: no managed install here)");
  say(`tables.mjs run: ${script}`);

  const PGlite = await checkoutPGlite();
  const base = await buildState(PGlite, join(dir, 'base'));
  check(
    !existsSync(join(base, 'pglite', 'postmaster.pid')),
    'synthetic state folder built (every migration of this checkout); PGlite left no postmaster.pid',
  );
  const same = [join(dir, 'same-a'), join(dir, 'same-b')];
  for (const to of same) await cp(base, to, { recursive: true, errorOnExist: true, force: false });
  const closed = String(await closedPort());

  let runs = 0;
  const tool = async (name, args, port = closed) => {
    runs += 1;
    const result = await runTool(script, [...args, '--scratch', scratch, '--port', port]);
    const text = report(result);
    if (log) await writeFile(log(name), `${text}\n`);
    say(`tables.mjs ${name}:`);
    for (const line of text.split(/\r?\n/)) say(`  | ${line}`);
    return result;
  };
  // A failed check carries the run's exit code, stdout and stderr: names, counts, fingerprints.
  const expect = (result, ok, label) => {
    if (!ok) throw new Error(`Check failed: ${label}\n${report(result)}`);
    check(true, label);
  };
  const afterRun = async (label, result, folders) => {
    const left = await readdir(scratch);
    expect(result, left.length === 0, `${label}: scratch empty afterwards (${left.join(', ')})`);
    for (const [folder, was] of folders)
      expect(
        result,
        digest(await tree(folder)) === was,
        `${label}: ${folder} byte-identical afterwards`,
      );
    expect(
      result,
      !`${result.stdout}${result.stderr}`.includes(MARK),
      `${label}: no seeded value printed`,
    );
  };
  const digestOf = async (folder) => [folder, digest(await tree(folder))];

  // a. Identical.
  const sameDigests = [await digestOf(same[0]), await digestOf(same[1])];
  check(sameDigests[0][1] === sameDigests[1][1], 'the two folders are byte copies of one another');
  const a = await tool('identical', ['--before', same[0], '--after', same[1], ...appArgs]);
  expect(a, a.code === 0, `identical folders: exit 0 (got ${a.code})`);
  expect(
    a,
    lastLine(a.stdout) === 'RESULT: no difference',
    'identical folders: last line RESULT: no difference',
  );
  expect(
    a,
    /^Structure: compared \(/m.test(a.stdout) && /^users: 2 -> 2, identical/m.test(a.stdout),
    'identical folders: structure compared, users identical',
  );
  await afterRun('identical folders', a, sameDigests);

  // b. One changed row.
  const other = await changed(PGlite, base, join(dir, 'changed-row'), CHANGE);
  const otherDigest = await digestOf(other);
  const b = await tool('one-changed-row', ['--before', same[0], '--after', other, ...appArgs]);
  expect(b, b.code === 1, `one changed row: exit 1 (got ${b.code})`);
  expect(
    b,
    /^RESULT: [1-9]\d* differences?$/m.test(b.stdout),
    'one changed row: a RESULT: N difference(s) line',
  );
  expect(
    b,
    /^users: 2 -> 2, row \[[0-9a-f]{8}\] differs in password_hash$/m.test(b.stdout),
    'one changed row: users reports the row by fingerprint, password_hash named',
  );
  await afterRun('one changed row', b, [sameDigests[0], otherDigest]);

  // c. Junctions: an input that is one, an input that holds one.
  const outside = join(dir, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'nota.txt'), `${MARK} nota`);
  const outsideDigest = await digestOf(outside);
  const isLink = join(dir, 'junction-to-same-a');
  await junction(same[0], isLink);
  const holds = join(dir, 'holds-junction');
  await cp(base, holds, { recursive: true, errorOnExist: true, force: false });
  const innerLink = join(holds, 'uploads', 'enlace');
  await junction(outside, innerLink);
  for (const path of [isLink, innerLink]) {
    if (platform === 'win32') {
      const type = windowsLinkType(path);
      check(type === 'Junction', `${path} is a junction (Windows: ${type || 'not a link'})`);
    }
    check((await lstat(path)).isSymbolicLink(), `Node reports ${path} as a link`);
  }
  const c1 = await tool('input-is-junction', ['--before', isLink, '--after', same[1], ...appArgs]);
  expect(c1, c1.code === 2, `input that is a junction: exit 2 (got ${c1.code})`);
  expect(
    c1,
    lastLine(c1.stdout) ===
      `RESULT: not compared (--before ${isLink} is a link or junction; pass the real folder)`,
    'input that is a junction: RESULT: not compared (--before … is a link or junction …)',
  );
  await afterRun('input that is a junction', c1, sameDigests);
  const holdsDigest = await digestOf(join(holds, 'pglite'));
  const c2 = await tool('input-holds-junction', ['--before', same[0], '--after', holds, ...appArgs]);
  expect(c2, c2.code === 2, `input that holds a junction: exit 2 (got ${c2.code})`);
  expect(
    c2,
    lastLine(c2.stdout) ===
      `RESULT: not compared (${holds} holds a link, junction or special file (uploads/enlace); pass a plain copy)`,
    'input that holds a junction: RESULT: not compared (… holds a link, junction or special file (uploads/enlace) …)',
  );
  await afterRun('input that holds a junction', c2, [sameDigests[0], holdsDigest, outsideDigest]);
  expect(
    c2,
    (await lstat(innerLink)).isSymbolicLink(),
    'input that holds a junction: the junction is still there',
  );

  // d. --app is used: a folder that is no managed install is refused, not skipped.
  const notApp = join(dir, 'not-an-install');
  await mkdir(notApp);
  const d = await tool('app-not-an-install', [
    '--before',
    same[0],
    '--after',
    same[1],
    '--app',
    notApp,
  ]);
  expect(d, d.code === 2, `--app without current.json: exit 2 (got ${d.code})`);
  expect(
    d,
    lastLine(d.stdout) ===
      `RESULT: not compared (--app ${notApp} is not a managed install root (no current.json))`,
    '--app without current.json: RESULT: not compared (… is not a managed install root …)',
  );
  await afterRun('--app without current.json', d, sameDigests);

  // e. SIPGES open: something answers on the port given with --port.
  const server = createServer((socket) => socket.end()).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const busy = String(server.address().port);
  let e;
  try {
    e = await tool('port-answers', ['--before', same[0], '--after', same[1], ...appArgs], busy);
  } finally {
    server.close();
  }
  expect(e, e.code === 2, `something answers on --port ${busy}: exit 2 (got ${e.code})`);
  expect(
    e,
    lastLine(e.stdout).startsWith(`RESULT: not compared (SIPGES answers on port ${busy}: `),
    `something answers on --port: RESULT: not compared (SIPGES answers on port ${busy}: …)`,
  );
  await afterRun('something answers on --port', e, sameDigests);

  say(
    `tables.mjs: ${runs} runs passed with PGlite from ${pglite === 'managed' ? 'the managed install (--app)' : 'this checkout'}`,
  );
  say(
    'not run: an interrupt (Ctrl+C) and closing the console window. On Windows child.kill() ends the process outright and delivers no signal; tables-interrupt.mjs sends a real console Ctrl+C, and closing the console window is not driven.',
  );
  return { pglite, runs };
}
