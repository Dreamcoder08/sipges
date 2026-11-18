// The Go mode rehearsal on a real Windows machine, synthetic data only (go-rust-stack T72c,
// T72d3, docs/adr/0036 §5-6):
//
//   node deploy/desktop/windows/go-drill.mjs [--work <new dir>] [--logs <dir>]
//
// Run it from an installed checkout (pnpm install --frozen-lockfile) with Go on PATH, on a Windows
// computer or account that is NOT the laptop: .github/workflows/windows-desktop.yml (go-mode job)
// runs it on windows-latest as the runner's standard user. LOCALAPPDATA points at a scratch folder.
//
// 1. A package built with `builder.mjs --go` (sipges-desktop, the Go API, the migrations and the
//    pinned PostgreSQL 18 from deploy/desktop/postgresql), signed with a throwaway key, and a
//    second release of the same package one version newer. install.ps1 -Release installs the
//    first one, with no Node on the PATH, with the trusted sipges-desktop.exe built from this
//    checkout into deploy\desktop\bin (what the kit carries), never the release's own.
// 2. An install still on PGlite: its TypeScript launcher (run-current.mjs, as the shortcut ran it
//    before) serves from node.exe; synthetic data go in through the public API (rehearse.mjs's
//    seed); snapshot.mjs. Then the installed start.ps1 keeps it on the TypeScript launcher.
// 3. start.ps1 -Go refuses, changing nothing, while the data are only in PGlite.
// 4. The move, as the visit does it: the state folder copied; `sipges-desktop.exe --install <root>
//    --prepare-only` (no Node) creates the cluster in <state>\pg18 with the roles and an empty
//    database and stops it, leaving pg18.pending-move. Opened before the move, start.ps1 stays on
//    TypeScript and the Go launcher refuses the cluster. The bundled pg_ctl starts it on a free
//    loopback port, pglite-to-postgres.mjs --prepared moves the copy into it with its
//    table-by-table proof and removes the mark, pg_ctl stops it.
// 5. start.ps1, with no switch and no Node on the PATH: the Go launcher (sipges-desktop.exe
//    --install) applies the migrations on start and serves the Go API (api.exe) on port 8000;
//    compare.mjs finds no difference.
// 6. The launcher is killed (its whole process tree, taskkill /F) while writes are in flight;
//    start.ps1 again stops a PostgreSQL that outlived it, if any, and SIPGES reads.
// 7. The update: the second release copied into <root>\releases; start.ps1 (no Node): the Go
//    launcher offers it, an administrator asks for it through POST /system/desktop/update, the Go
//    launcher applies it (copy, migrate, ready, switch) and serves it; compare.mjs.
// 8. Clean stop: sipges-desktop in a console of its own answers, then a Ctrl+C stops the API and
//    PostgreSQL: exit 0, «PostgreSQL stopped», no postgres.exe left, port 8000 free.
// 9. The way back: the original PGlite folder (<state>\pglite) is byte-identical to step 2; with
//    pg18 set aside start.ps1 serves it again from node.exe and compare.mjs finds no difference.
//
// Logs and command outputs go to --logs; never a state folder, a snapshot or the key.
/* global fetch */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import console from 'node:console';
import { signIn } from '../migration/client.mjs';
import { LOGIN, digest, seed, tree } from '../migration/rehearse.mjs';
import {
  BASE,
  POWERSHELL,
  check,
  childEnv,
  endServer,
  events,
  healthy,
  killTree,
  launch,
  portListeners,
  psArgs,
  psLines,
  quotePs,
  readJson,
  run,
  runNode as node,
  say,
  setLog,
  sizeOf,
  step,
  trees,
  waitFor,
} from './drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const ALFA = 'SINTETICA/PRJ-ALFA';

/** start-managed.ps1 -Go on a version built without --go. */
export const GO_MISSING_LINE = 'Esta versión de SIPGES no incluye el modo Go. Abra SIPGES desde su acceso directo habitual.';
/** start-managed.ps1 -Go while the data are still only in PGlite. */
export const GO_NOT_MOVED_LINE =
  'SIPGES no se inició en modo Go: sus datos todavía no se movieron a PostgreSQL. No se tocó nada. Abra SIPGES desde su acceso directo habitual.';

const USAGE = `Usage: node deploy/desktop/windows/go-drill.mjs [--work <new dir>] [--logs <dir>]
Windows only, synthetic data only. Needs this checkout installed and Go on PATH.`;

/** The PATH of `env` without the folders holding node.exe: what a computer without Node has. */
export function withoutNode(env, hasNode = (dir) => existsSync(join(dir, 'node.exe'))) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const kept = (env[key] ?? '').split(';').filter((dir) => dir && !hasNode(dir));
  return { ...env, [key]: kept.join(';') };
}

/** The version of the update release: the patch after the drill's own, same suffix. */
export function nextVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) throw new Error(`Invalid version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ?? ''}`;
}

export function parseOptions(args, { now = new Date(), tmp = tmpdir() } = {}) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--work', '--logs'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error(`Invalid options.\n${USAGE}`);
    options[args[i]] = args[i + 1];
  }
  const digits = now.toISOString().replace(/\D/g, '').slice(0, 14);
  const work = resolve(options['--work'] ?? join(tmp, `sipges-go-drill-${digits}`));
  return { work, logs: resolve(options['--logs'] ?? join(work, 'logs')), version: `0.0.9-go.${digits}` };
}

/** The port in a PostgreSQL postmaster.pid (its fourth line), or null. */
export function postmasterPort(text) {
  const port = Number((text ?? '').split(/\r?\n/)[3]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** The image name of a process id from `tasklist /FO CSV /NH`, or null. */
export function imageName(csv) {
  const match = /^"([^"]+)"/.exec((csv ?? '').trim());
  return match ? match[1] : null;
}

/** A TCP port free on 127.0.0.1 right now. */
const freePort = () =>
  new Promise((done, fail) => {
    const server = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

const processName = (pid) => imageName(spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout);
/** How many postgres.exe run from `bin` (the installed bundle): never another PostgreSQL. */
function postgresFrom(bin) {
  const filter = `${bin.replace(/'/g, "''")}\\*`;
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object { $_.ExecutablePath -like '${filter}' }).Count`], { encoding: 'utf8' });
  const count = Number((result.stdout ?? '').trim());
  if (result.status !== 0 || !Number.isInteger(count)) throw new Error(`cannot list postgres.exe processes: ${(result.stderr ?? '').trim()}`);
  return count;
}
const serverImage = () => {
  const pids = portListeners();
  return pids.length === 1 ? processName(pids[0]) : `${pids.length} listeners`;
};

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(USAGE);
  const options = parseOptions(args);
  if (process.platform !== 'win32') throw new Error('the Go mode rehearsal runs on Windows only');
  if (existsSync(options.work) && readdirSync(options.work).length > 0) throw new Error(`${options.work} already exists and is not empty`);
  mkdirSync(options.work, { recursive: true });
  const work = realpathSync.native(options.work);
  const logs = options.logs;
  mkdirSync(logs, { recursive: true });
  setLog(join(logs, 'go-drill.txt'));
  const out = (name) => join(logs, `${name}.txt`);
  const lad = join(work, 'LocalAppData');
  const env = childEnv(process.env, { LOCALAPPDATA: lad });
  const appRoot = join(lad, 'SIPGES-app');
  const state = join(lad, 'SIPGES');
  const keyDir = join(work, 'key');
  const consoleHelper = join(here, 'go-console.ps1');
  // Set once installed: the bundle's bin folder, whose postgres.exe processes the checks count.
  let pgBin = null;
  const postgresRunning = () => postgresFrom(pgBin) > 0;

  /** sipges-desktop.exe (or another program) in a console of its own; `stop()` sends Ctrl+C. */
  const inConsole = (name, exe, exeArgs, extra) => {
    const stopFile = join(work, `${name}.stop`);
    const report = join(work, `${name}.report.json`);
    const child = launch(POWERSHELL, psArgs(consoleHelper), {
      env: { ...env, ...extra, GC_EXE: exe, GC_ARGS_JSON: JSON.stringify(exeArgs), GC_STOP: stopFile, GC_REPORT: report, GC_TIMEOUT_MS: String(600_000) },
      log: out(name),
    });
    return {
      child,
      stop: async () => {
        writeFileSync(stopFile, 'stop\n');
        const ended = await child.ended;
        const result = existsSync(report) ? await readJson(report) : null;
        if (result) writeFileSync(out(`${name}-output`), `${result.stdout}\n--- stderr\n${result.stderr}\n`);
        return { status: ended.status, report: result };
      },
    };
  };
  const cleanUp = () => {
    for (const pid of [...trees]) killTree(pid);
    for (const pid of portListeners()) killTree(pid);
    // Only the rehearsal's own cluster, with its own pg_ctl.
    for (const cluster of ['pg18', 'pg18.vuelta'])
      if (pgBin && existsSync(join(state, cluster, 'postmaster.pid')))
        spawnSync(join(pgBin, 'pg_ctl.exe'), ['stop', '-D', join(state, cluster), '-m', 'immediate', '-w'], { stdio: 'ignore' });
    rmSync(keyDir, { recursive: true, force: true });
    rmSync(join(repo, 'deploy', 'desktop', 'bin', 'sipges-desktop.exe'), { force: true });
    for (const [from, name] of [
      [join(appRoot, 'launcher.log'), 'launcher.log'],
      [join(state, 'pg18.log'), 'pg18.log'],
    ])
      if (existsSync(from)) cpSync(from, join(logs, name));
  };
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      say(`\n${signal}: ending every process of the rehearsal`);
      cleanUp();
      process.exit(130);
    });

  try {
    step('0. Checks');
    check(Number(process.versions.node.split('.')[0]) >= 24, `Node.js ${process.versions.node} (24 or later)`);
    check(existsSync(join(repo, 'node_modules', 'typescript')), 'this checkout is installed');
    const goVersion = spawnSync('go', ['version'], { encoding: 'utf8' });
    check(goVersion.status === 0, `Go answers: ${(goVersion.stdout ?? '').trim()}`);
    check(portListeners().length === 0 && !(await healthy()), 'nothing listens on port 8000');

    const nextV = nextVersion(options.version);
    step(`1. Package ${options.version} built with --go, signed with ${nextV}, installed by its own sipges-desktop without Node`);
    const packageDir = join(repo, '.data', 'desktop-packages', `sipges-${options.version}`);
    const built = await node([join(repo, 'deploy', 'desktop', 'package', 'builder.mjs'), '--version', options.version, '--out', packageDir, '--go'], { log: out('build') });
    check(built.status === 0 && built.output.includes(`Package created: ${packageDir}`), 'builder.mjs --go exit 0');
    const metadata = await readJson(join(packageDir, 'metadata.json'));
    const pin = await readJson(join(repo, 'deploy', 'desktop', 'postgresql', 'pg18.json'));
    check(metadata.entry === 'start.mjs', 'the package entry is still the TypeScript one');
    check(metadata.go?.postgresql?.sha256 === pin.sha256, `metadata.json records PostgreSQL ${pin.version} with the pinned SHA-256`);
    for (const file of ['go/sipges-desktop.exe', 'go/api.exe', 'postgresql/bin/pg_ctl.exe', 'postgresql/bin/initdb.exe', 'postgresql/bin/postgres.exe', 'postgresql/postgresql.json'])
      check(existsSync(join(packageDir, ...file.split('/'))), `the package holds ${file}`);
    check(!existsSync(join(packageDir, 'postgresql', 'bin', 'stackbuilder.exe')) && !existsSync(join(packageDir, 'postgresql', 'pgAdmin 4')), 'the bundle is trimmed');
    // The update: the same package one version newer (only metadata.json differs).
    const nextPackage = join(work, `package-${nextV}`);
    cpSync(packageDir, nextPackage, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(nextPackage, 'metadata.json'), `${JSON.stringify({ ...metadata, version: nextV }, null, 2)}\n`);
    mkdirSync(keyDir, { recursive: true });
    const key = join(keyDir, 'sipges-clave-actualizaciones.pem');
    const made = await psLines(work, 'key', [`node -e "const c=require('crypto');require('fs').writeFileSync(process.argv[1],c.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx'})" ${quotePs(key)}`], { env, log: out('key') });
    check(made.status === 0 && existsSync(key), 'a throwaway Ed25519 key');
    const release = join(work, 'usb', `release-${options.version}`);
    const nextRelease = join(work, 'usb', `release-${nextV}`);
    mkdirSync(dirname(release), { recursive: true });
    for (const [pkg, dir, label] of [[packageDir, release, options.version], [nextPackage, nextRelease, nextV]]) {
      const signed = await node([join(repo, 'deploy', 'desktop', 'updater', 'release.mjs'), '--package', pkg, '--out', dir, '--key', key, '--notes', 'Ensayo sintético del modo Go.'], { log: out(`release-${label}`) });
      check(signed.status === 0, `release.mjs signed ${label}`);
    }
    rmSync(keyDir, { recursive: true, force: true });
    mkdirSync(lad, { recursive: true });
    const noNode = withoutNode(env);
    const nodeOnPath = spawnSync('where.exe', ['node'], { env: noNode, encoding: 'utf8' });
    check(nodeOnPath.status !== 0, 'without the Node folders on PATH, where.exe finds no node');
    // The kit's trusted installer, built from this checkout: install.ps1 verifies and installs a Go
    // release with it, never with the release's own binary.
    const trusted = join(repo, 'deploy', 'desktop', 'bin', 'sipges-desktop.exe');
    const builtTrusted = await run('go', ['build', '-o', trusted, './cmd/sipges-desktop'], { cwd: join(repo, 'apps', 'api-go'), env: process.env, log: out('trusted-installer') });
    check(builtTrusted.status === 0 && existsSync(trusted), 'the trusted sipges-desktop.exe built into deploy\\desktop\\bin');
    const installed = await run(POWERSHELL, psArgs(join(here, 'install.ps1'), ['-Release', release]), { env: noNode, log: out('install') });
    check(installed.status === 0 && installed.output.includes('Trusting the update key that signed this release (SHA-256 '), 'install.ps1 -Release ran the trusted sipges-desktop (it printed the key fingerprint)');
    check(installed.output.includes(`Installed ${options.version}`), `install.ps1 -Release installed ${options.version} without Node`);
    check((await readJson(join(appRoot, 'install.json'))).stateDir === state, `install.json records ${state}`);
    let version = join(appRoot, ...(await readJson(join(appRoot, 'current.json'))).path.split('/'));
    pgBin = join(version, 'postgresql', 'bin');
    check(existsSync(join(pgBin, 'pg_ctl.exe')), 'the installed version carries the PostgreSQL bundle');

    step('2. An install still on PGlite: the TypeScript launcher, synthetic data, snapshot');
    const startPs = join(appRoot, 'start.ps1');
    const launcherLog = join(appRoot, 'launcher.log');
    const startManaged = async (name, extraArgs = [], startEnv = env) => {
      const child = launch(POWERSHELL, psArgs(startPs, extraArgs), { env: { ...startEnv, SIPGES_DESKTOP_NO_UI: '1' }, log: out(name) });
      await waitFor(`${name}: SIPGES answers`, 300, healthy, child);
      return child;
    };
    const stopTree = async (child, label) => {
      killTree(child.pid);
      await endServer(label);
      await child.ended;
    };
    // How an install made before the Go launcher got its data: its shortcut ran run-current.mjs.
    let ts = launch(process.execPath, [join(appRoot, 'run-current.mjs'), '--releases', join(work, 'no-releases')], { env, log: out('ts-launcher') });
    await waitFor('the TypeScript launcher answers', 300, healthy, ts);
    check(serverImage() === 'node.exe', 'run-current.mjs serves from node.exe (the TypeScript API)');
    const secrets = await seed(BASE, state, work);
    say('synthetic data seeded: 2 projects, records, links, uploads, admin with MFA, a second account');
    const before = join(work, 'sipges-antes.json');
    const snapshot = await node([join(repo, 'deploy', 'desktop', 'migration', 'snapshot.mjs'), '--url', BASE, '--out', before, ...LOGIN(secrets, state)], { log: out('snapshot') });
    check(snapshot.status === 0 && snapshot.output.includes('Written:'), 'snapshot.mjs exit 0');
    await stopTree(ts, 'TypeScript launcher');
    ts = await startManaged('ts-start-1');
    check(serverImage() === 'node.exe', 'start.ps1 keeps data only in PGlite on the TypeScript launcher (node.exe)');
    await stopTree(ts, 'TypeScript version');
    const pglite = join(state, 'pglite');
    // A killed PGlite leaves pglite\postmaster.pid, which the move reads as «SIPGES open» for two
    // minutes: the runbook closes SIPGES and waits, so does the rehearsal.
    const lock = join(pglite, 'postmaster.pid');
    if (existsSync(lock)) {
      const wait = statSync(lock).mtimeMs + 125_000 - Date.now();
      if (wait > 0) {
        say(`pglite\\postmaster.pid is fresh: waiting ${Math.ceil(wait / 1000)} s, as after closing SIPGES`);
        await sleep(wait);
      }
    }
    const pgliteDigest = digest(await tree(pglite));
    say(`original PGlite folder digest ${pgliteDigest}`);

    const compare = async (label) => {
      const result = await node([join(repo, 'deploy', 'desktop', 'migration', 'compare.mjs'), '--before', before, '--url', BASE, ...LOGIN(secrets, state)], { log: out(`compare-${label}`) });
      check(result.status === 0 && result.output.includes('RESULT: no difference'), `compare.mjs: RESULT: no difference (${label})`);
      check(!/not (fully )?checked/.test(result.output), `compare.mjs: every part checked (${label})`);
    };

    step('3. start.ps1 -Go refuses while the data are only in PGlite');
    const refused = await run(POWERSHELL, psArgs(startPs, ['-Go']), { env: { ...env, SIPGES_DESKTOP_NO_UI: '1' }, log: out('go-refused'), seconds: 120 });
    check(refused.status === 1 && refused.output.includes(GO_NOT_MOVED_LINE), `start.ps1 -Go exit 1: «${GO_NOT_MOVED_LINE.split(':')[0]}…»`);
    check(!existsSync(join(state, 'pg18')) && !(await healthy()), 'no cluster was made and nothing answers');
    check(digest(await tree(pglite)) === pgliteDigest, 'the PGlite folder is byte-identical');

    step('4. The move: sipges-desktop --prepare-only, pglite-to-postgres.mjs into it');
    const copy = join(work, 'state-copy');
    cpSync(state, copy, { recursive: true });
    check(digest(await tree(join(copy, 'pglite'))) === pgliteDigest, 'the copy of the state folder holds the same PGlite');
    let desktop = join(version, 'go', 'sipges-desktop.exe');
    const goEnv = () => ({ SIPGES_DESKTOP_STATE: state, SIPGES_PG_BIN: pgBin, SIPGES_WEB_DIR: join(version, 'web') });
    const preparedRun = await run(desktop, ['--install', appRoot, '--prepare-only'], { env: noNode, log: out('prepare-only') });
    check(preparedRun.status === 0 && preparedRun.output.includes(`sipges-desktop: PostgreSQL 18 prepared in ${join(state, 'pg18')}`), 'sipges-desktop --prepare-only made the cluster, without Node');
    check(!postgresRunning() && !existsSync(join(state, 'pg18', 'postmaster.pid')), '--prepare-only stopped PostgreSQL');
    const again2 = await run(desktop, ['--install', appRoot, '--prepare-only'], { env: noNode, log: out('prepare-only-again') });
    check(again2.status === 1 && again2.output.includes('ya tiene una base de datos PostgreSQL 18'), 'a second --prepare-only is refused');
    check(existsSync(join(state, 'pg18.pending-move')), '--prepare-only left pg18.pending-move');
    // The trap between G3 and G4: the shortcut must not start Go on the empty cluster.
    const between = await startManaged('ts-between-prepare-and-move');
    check(serverImage() === 'node.exe', 'start.ps1 between --prepare-only and the move stays on TypeScript (node.exe)');
    await stopTree(between, 'TypeScript version');
    check(existsSync(join(state, 'pg18.pending-move')) && !postgresRunning(), 'the prepared cluster was not started and is still waiting for the move');
    // That TypeScript open is the last one to write PGlite: the way back is compared with it.
    const pgliteAfterBetween = digest(await tree(pglite));
    const refusedGo = await run(POWERSHELL, psArgs(startPs, ['-Go']), { env: { ...noNode, SIPGES_DESKTOP_NO_UI: '1' }, log: out('go-refused-pending'), seconds: 120 });
    check(refusedGo.status === 1 && refusedGo.output.includes(GO_NOT_MOVED_LINE), 'start.ps1 -Go refuses the prepared cluster before the move');
    const launcherRefused = await run(desktop, ['--install', appRoot], { env: noNode, log: out('launcher-refused-pending'), seconds: 120 });
    check(launcherRefused.status === 1 && launcherRefused.output.includes('pg18.pending-move'), 'sipges-desktop --install refuses the prepared cluster before the move');
    check(!postgresRunning(), 'nothing started PostgreSQL on the prepared cluster');
    const port = await freePort();
    const pgCtl = join(pgBin, 'pg_ctl.exe');
    const startedPg = await run(pgCtl, ['start', '-D', join(state, 'pg18'), '-l', join(state, 'pg18.log'), '-w', '-t', '120', '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`], { env, log: out('pg-start-for-move') });
    check(startedPg.status === 0, `pg_ctl started the cluster for the move on 127.0.0.1:${port}`);
    const appPassword = (await readFile(join(state, 'pg18-app-password'), 'utf8')).trim();
    mkdirSync(join(work, 'move-scratch'));
    const moved = await node([join(repo, 'deploy', 'desktop', 'migration', 'pglite-to-postgres.mjs'), '--state', copy, '--prepared', state, '--scratch', join(work, 'move-scratch')], {
      env: { ...env, SIPGES_MOVE_DATABASE_URL: `postgres://sipges_app:${encodeURIComponent(appPassword)}@127.0.0.1:${port}/sipges` },
      log: out('move'),
    });
    check(moved.status === 0 && moved.output.includes('Moved: the target holds the copy, committed.'), 'pglite-to-postgres.mjs filled the prepared database with no difference (tables.mjs inside the transaction)');
    check(moved.output.includes('The prepared cluster is ready: removed pg18.pending-move.') && !existsSync(join(state, 'pg18.pending-move')), 'the committed move removed pg18.pending-move');
    const stoppedPg = await run(pgCtl, ['stop', '-D', join(state, 'pg18'), '-m', 'fast', '-w', '-t', '120'], { env, log: out('pg-stop-after-move') });
    check(stoppedPg.status === 0 && !postgresRunning(), 'pg_ctl stopped the cluster: no postgres.exe left');

    step('5. start.ps1 with no switch and no Node: the Go launcher on the moved data');
    let goStart = await startManaged('go-start-1', [], noNode);
    check(serverImage() === 'api.exe', 'start.ps1 serves from api.exe (the Go API) once the data are in pg18');
    const started = (await events(launcherLog)).filter((e) => e.event === 'started').at(-1);
    check(started?.version === options.version, `the Go launcher started ${options.version} (${JSON.stringify(started)})`);
    const health = await fetch(`${BASE}/health`);
    check(health.status === 200, 'GET /health 200');
    await health.arrayBuffer();
    await compare('go');

    step('6. The launcher killed during writes, then started again');
    const password = (await readFile(join(state, 'admin-password'), 'utf8')).trim();
    const totpSecret = (await readFile(secrets.secretFile, 'utf8')).trim();
    const admin = await signIn({ base: BASE, username: 'admin', password, totpSecret, totpState: secrets.totpState });
    const writes = Array.from({ length: 20 }, (_, i) =>
      admin
        .call('/api/eventos', {
          scope: ALFA,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: { ID_Evento: `EV-CORTE-${String(i).padStart(3, '0')}`, Titulo: 'Escritura sintética interrumpida', Fecha: '2026-03-01' } }),
        })
        .then((r) => r.status, (e) => e.message),
    );
    await sleep(50);
    killTree(goStart.pid);
    const outcomes = await Promise.all(writes);
    say(`writes in flight when the launcher was killed: ${JSON.stringify(outcomes)}`);
    await goStart.ended;
    await waitFor('SIPGES stopped answering', 60, async () => !(await healthy()) && portListeners().length === 0);
    // The launcher's job object normally ends PostgreSQL with it; when it outlives it, the next
    // start stops it before anything else.
    say(postgresRunning() ? 'the PostgreSQL the killed launcher started outlives it (an orphan)' : 'the PostgreSQL ended with the killed launcher (its job object)');
    goStart = await startManaged('go-start-2', [], noNode);
    check(serverImage() === 'api.exe', 'start.ps1 again: the Go API answers');
    const again = await signIn({ base: BASE, username: 'admin', password, totpSecret, totpState: secrets.totpState });
    const list = await again.call('/api/eventos', { scope: ALFA });
    await list.arrayBuffer();
    check(list.status === 200, 'after the restart the records read (GET /api/eventos 200)');
    await stopTree(goStart, 'Go launcher');
    await waitFor('PostgreSQL stopped', 120, async () => !postgresRunning());

    step(`7. The update to ${nextV}: offered and applied by the Go launcher`);
    // The writes of step 6 are in pg18 only: a fresh snapshot is what the update must keep.
    const beforeUpdate = join(work, 'sipges-antes-de-actualizar.json');
    cpSync(nextRelease, join(appRoot, 'releases', `release-${nextV}`), { recursive: true, verbatimSymlinks: true });
    const from = await sizeOf(launcherLog);
    goStart = await startManaged('go-start-3', [], noNode);
    const offered = await waitFor('the update check', 180, async () =>
      (await events(launcherLog, from)).find((e) => e.event === 'update_check' || e.event === 'update_check_failed'),
    );
    check(offered.event === 'update_check' && offered.available === nextV, `the Go launcher offers ${nextV} (${JSON.stringify(offered)})`);
    const pre = await node([join(repo, 'deploy', 'desktop', 'migration', 'snapshot.mjs'), '--url', BASE, '--out', beforeUpdate, ...LOGIN(secrets, state)], { log: out('snapshot-before-update') });
    check(pre.status === 0, 'snapshot.mjs before the update exit 0');
    const updater = await signIn({ base: BASE, username: 'admin', password, totpSecret, totpState: secrets.totpState });
    const shown = await updater.call('/system/desktop/update', { scope: ALFA });
    const notice = shown.status === 200 ? await shown.json() : { status: shown.status };
    check(notice.installed === options.version && notice.available === nextV, `GET /system/desktop/update: ${JSON.stringify({ installed: notice.installed, available: notice.available })}`);
    const asked = await updater.call('/system/desktop/update', { scope: ALFA, method: 'POST' });
    const restarting = asked.status === 202 ? await asked.json() : { status: asked.status };
    check(restarting.status === 'restarting' && restarting.version === nextV, `POST /system/desktop/update: 202 restarting ${nextV}`);
    const outcome = await waitFor(
      'the update',
      900,
      async () =>
        (await events(launcherLog, from)).find((e) =>
          ['updated', 'update_failed', 'start_failed', 'update_request_refused', 'update_request_ignored', 'update_cancelled'].includes(e.event),
        ),
      goStart,
    );
    check(outcome.event === 'updated' && outcome.to === nextV, `the Go launcher updated to ${nextV} (${JSON.stringify(outcome)})`);
    await waitFor('SIPGES after the update', 240, healthy, goStart);
    check(serverImage() === 'api.exe', 'after the update the Go API answers');
    check((await readJson(join(appRoot, 'current.json'))).version === nextV, `current.json: ${nextV}`);
    const kept = await node([join(repo, 'deploy', 'desktop', 'migration', 'compare.mjs'), '--before', beforeUpdate, '--url', BASE, ...LOGIN(secrets, state)], { log: out('compare-after-update') });
    check(kept.status === 0 && kept.output.includes('RESULT: no difference'), 'compare.mjs after the update: RESULT: no difference');
    version = join(appRoot, ...(await readJson(join(appRoot, 'current.json'))).path.split('/'));
    pgBin = join(version, 'postgresql', 'bin');
    desktop = join(version, 'go', 'sipges-desktop.exe');
    await stopTree(goStart, 'Go launcher');
    await waitFor('PostgreSQL stopped', 120, async () => !postgresRunning());

    step('8. Clean stop: sipges-desktop in a console, Ctrl+C');
    const serving = inConsole('clean-stop', desktop, [], goEnv());
    await waitFor('sipges-desktop answers', 240, healthy, serving.child);
    check(serverImage() === 'api.exe', 'sipges-desktop serves the Go API');
    const stopped = await serving.stop();
    check(stopped.report?.sent === true && stopped.report?.exitCode === 0, `Ctrl+C: sipges-desktop exit 0 (got ${stopped.report?.exitCode}, ${stopped.report?.error ?? 'no error'})`);
    check(stopped.report.stdout.includes('PostgreSQL stopped'), 'sipges-desktop printed «PostgreSQL stopped»');
    check(!postgresRunning() && !existsSync(join(state, 'pg18', 'postmaster.pid')), 'no postgres.exe and no postmaster.pid left');
    check(portListeners().length === 0 && !(await healthy()), 'port 8000 is free');

    step('9. The way back: pg18 set aside, the original PGlite folder on the TypeScript launcher');
    check(digest(await tree(pglite)) === pgliteAfterBetween, 'the original PGlite folder is byte-identical after the whole Go rehearsal (since its last TypeScript open)');
    const aside = join(state, 'pg18.vuelta');
    renameSync(join(state, 'pg18'), aside);
    ts = await startManaged('ts-start-2');
    check(serverImage() === 'node.exe', 'with pg18 set aside start.ps1 serves PGlite from node.exe again');
    await compare('back-to-typescript');
    await stopTree(ts, 'TypeScript version');
    check(existsSync(join(aside, 'PG_VERSION')), `the Go data stay in ${aside} (renamed back to pg18 to return to Go)`);
    say('\nGO MODE REHEARSAL PASSED');
  } finally {
    cleanUp();
    say(`work folder kept (synthetic data only): ${work}; the throwaway key was deleted`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    say(`GO DRILL FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
