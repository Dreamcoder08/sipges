// The Go mode rehearsal on a real Windows machine, synthetic data only (go-rust-stack T72c,
// docs/adr/0036 §6):
//
//   node deploy/desktop/windows/go-drill.mjs [--work <new dir>] [--logs <dir>]
//
// Run it from an installed checkout (pnpm install --frozen-lockfile) with Go on PATH, on a Windows
// computer or account that is NOT the laptop: .github/workflows/windows-desktop.yml (go-mode job)
// runs it on windows-latest as the runner's standard user. LOCALAPPDATA points at a scratch folder.
//
// 1. A package built with `builder.mjs --go` (sipges-desktop, the Go API, the migrations and the
//    pinned PostgreSQL 18 from deploy/desktop/postgresql), signed with a throwaway key and
//    installed with install.ps1 -Release, as the visit does.
// 2. The default stays TypeScript: the installed start.ps1 without -Go serves from node.exe on
//    PGlite; synthetic data go in through the public API (rehearse.mjs's seed); snapshot.mjs.
// 3. start.ps1 -Go refuses, changing nothing, while the data are only in PGlite.
// 4. The move: the state folder copied; sipges-desktop.exe creates the cluster in <state>\pg18
//    with a stand-in API that applies no migration (built here from a few lines of Go), and while
//    it runs, pglite-to-postgres.mjs moves the copy into it with its table-by-table proof; then a
//    real Ctrl+C stops it cleanly (go-console.ps1).
// 5. start.ps1 -Go: the Go API (api.exe) answers /health on port 8000 and compare.mjs finds no
//    difference with the snapshot of step 2.
// 6. The launcher is killed (its whole process tree, taskkill /F) while writes are in flight; the
//    PostgreSQL it started outlives it. start.ps1 -Go again: the orphan is handled and SIPGES reads.
// 7. Clean stop: sipges-desktop.exe in a console of its own answers, then a Ctrl+C stops the API
//    and PostgreSQL: exit 0, «PostgreSQL stopped», no postgres.exe left, port 8000 free.
// 8. The original PGlite folder (<state>\pglite) is byte-identical to step 2; start.ps1 without
//    -Go serves it again from node.exe and compare.mjs finds no difference (the way back).
//
// Logs and command outputs go to --logs; never a state folder, a snapshot or the key.
/* global fetch */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

/** The stand-in API of step 4: `migrate` applies nothing; serving waits for Ctrl+Break. */
export const STUB_API = `package main

import (
	"fmt"
	"os"
	"os/signal"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		fmt.Println("stand-in api: no migration applied")
		return
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	if ready := os.Getenv("SIPGES_STUB_READY"); ready != "" {
		_ = os.WriteFile(ready, []byte("serving\\n"), 0o600)
	}
	fmt.Println("stand-in api: serving nothing until Ctrl+Break")
	<-stop
}
`;

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
    if (pgBin && existsSync(join(state, 'pg18', 'postmaster.pid')))
      spawnSync(join(pgBin, 'pg_ctl.exe'), ['stop', '-D', join(state, 'pg18'), '-m', 'immediate', '-w'], { stdio: 'ignore' });
    rmSync(keyDir, { recursive: true, force: true });
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

    step(`1. Package ${options.version} built with --go, signed, installed with install.ps1 -Release`);
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
    mkdirSync(keyDir, { recursive: true });
    const key = join(keyDir, 'sipges-clave-actualizaciones.pem');
    const made = await psLines(work, 'key', [`node -e "const c=require('crypto');require('fs').writeFileSync(process.argv[1],c.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx'})" ${quotePs(key)}`], { env, log: out('key') });
    check(made.status === 0 && existsSync(key), 'a throwaway Ed25519 key');
    const release = join(work, 'usb', `release-${options.version}`);
    mkdirSync(dirname(release), { recursive: true });
    const signed = await node([join(repo, 'deploy', 'desktop', 'updater', 'release.mjs'), '--package', packageDir, '--out', release, '--key', key, '--notes', 'Ensayo sintético del modo Go.'], { log: out('release') });
    check(signed.status === 0, 'release.mjs signed the package');
    rmSync(keyDir, { recursive: true, force: true });
    mkdirSync(lad, { recursive: true });
    const installed = await run(POWERSHELL, psArgs(join(here, 'install.ps1'), ['-Release', release]), { env, log: out('install') });
    check(installed.status === 0 && installed.output.includes(`Installed ${options.version}`), `install.ps1 -Release installed ${options.version}`);
    check((await readJson(join(appRoot, 'install.json'))).stateDir === state, `install.json records ${state}`);
    const version = join(appRoot, ...(await readJson(join(appRoot, 'current.json'))).path.split('/'));
    pgBin = join(version, 'postgresql', 'bin');
    check(existsSync(join(pgBin, 'pg_ctl.exe')), 'the installed version carries the PostgreSQL bundle');

    step('2. The default is TypeScript on PGlite: synthetic data, snapshot');
    const startPs = join(appRoot, 'start.ps1');
    const startManaged = async (name, extraArgs = []) => {
      const child = launch(POWERSHELL, psArgs(startPs, extraArgs), { env: { ...env, SIPGES_DESKTOP_NO_UI: '1' }, log: out(name) });
      await waitFor(`${name}: SIPGES answers`, 300, healthy, child);
      return child;
    };
    const stopTree = async (child, label) => {
      killTree(child.pid);
      await endServer(label);
      await child.ended;
    };
    let ts = await startManaged('ts-start-1');
    check(serverImage() === 'node.exe', 'start.ps1 without -Go serves from node.exe (the TypeScript API)');
    const secrets = await seed(BASE, state, work);
    say('synthetic data seeded: 2 projects, records, links, uploads, admin with MFA, a second account');
    const before = join(work, 'sipges-antes.json');
    const snapshot = await node([join(repo, 'deploy', 'desktop', 'migration', 'snapshot.mjs'), '--url', BASE, '--out', before, ...LOGIN(secrets, state)], { log: out('snapshot') });
    check(snapshot.status === 0 && snapshot.output.includes('Written:'), 'snapshot.mjs exit 0');
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

    step('4. The move: cluster created by sipges-desktop, the copy moved into it, clean stop');
    const copy = join(work, 'state-copy');
    cpSync(state, copy, { recursive: true });
    check(digest(await tree(join(copy, 'pglite'))) === pgliteDigest, 'the copy of the state folder holds the same PGlite');
    const stubDir = join(work, 'stand-in-api');
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, 'main.go'), STUB_API);
    const stub = join(stubDir, 'api.exe');
    const builtStub = await run('go', ['build', '-o', stub, 'main.go'], { cwd: stubDir, env: { ...process.env, GO111MODULE: 'off' }, log: out('stand-in-api') });
    check(builtStub.status === 0 && existsSync(stub), 'the stand-in API built');
    const desktop = join(version, 'go', 'sipges-desktop.exe');
    const goEnv = { SIPGES_DESKTOP_STATE: state, SIPGES_PG_BIN: pgBin, SIPGES_WEB_DIR: join(version, 'web') };
    const ready = join(work, 'stand-in-api.ready');
    const prepare = inConsole('prepare', desktop, ['--api', stub], { ...goEnv, SIPGES_STUB_READY: ready });
    await waitFor('the stand-in API serving', 240, async () => existsSync(ready), prepare.child);
    const port = postmasterPort(await readFile(join(state, 'pg18', 'postmaster.pid'), 'utf8'));
    check(port !== null && port !== 5432, `PostgreSQL 18 runs on 127.0.0.1:${port}, a port chosen free`);
    const appPassword = (await readFile(join(state, 'pg18-app-password'), 'utf8')).trim();
    mkdirSync(join(work, 'move-scratch'));
    const moved = await node([join(repo, 'deploy', 'desktop', 'migration', 'pglite-to-postgres.mjs'), '--state', copy, '--scratch', join(work, 'move-scratch')], {
      env: { ...env, SIPGES_MOVE_DATABASE_URL: `postgres://sipges_app:${encodeURIComponent(appPassword)}@127.0.0.1:${port}/sipges` },
      log: out('move'),
    });
    check(moved.status === 0 && moved.output.includes('Moved: the target holds the copy, committed.'), 'pglite-to-postgres.mjs moved the copy with no difference (tables.mjs inside the transaction)');
    const prepared = await prepare.stop();
    check(prepared.report?.sent === true && prepared.report?.exitCode === 0, `Ctrl+C: sipges-desktop exit 0 (got ${prepared.report?.exitCode}, ${prepared.report?.error ?? 'no error'})`);
    check(prepared.report.stdout.includes('PostgreSQL stopped'), 'sipges-desktop stopped PostgreSQL');
    check(!postgresRunning(), 'no postgres.exe left');

    step('5. start.ps1 -Go: the Go API on the moved data');
    let goStart = await startManaged('go-start-1', ['-Go']);
    check(serverImage() === 'api.exe', 'start.ps1 -Go serves from api.exe (the Go API)');
    const health = await fetch(`${BASE}/health`);
    check(health.status === 200, 'GET /health 200');
    await health.arrayBuffer();
    await compare('go');

    step('6. The launcher killed during writes, then started again (orphaned PostgreSQL)');
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
    check(postgresRunning(), 'the PostgreSQL the killed launcher started is still running (an orphan)');
    goStart = await startManaged('go-start-2', ['-Go']);
    check(serverImage() === 'api.exe', 'start.ps1 -Go again: the Go API answers');
    const again = await signIn({ base: BASE, username: 'admin', password, totpSecret, totpState: secrets.totpState });
    const list = await again.call('/api/eventos', { scope: ALFA });
    await list.arrayBuffer();
    check(list.status === 200, 'after the orphan the records read (GET /api/eventos 200)');
    killTree(goStart.pid);
    await goStart.ended;
    await waitFor('SIPGES stopped answering', 60, async () => !(await healthy()) && portListeners().length === 0);

    step('7. Clean stop: sipges-desktop in a console, Ctrl+C');
    const serving = inConsole('clean-stop', desktop, [], goEnv);
    await waitFor('sipges-desktop answers', 240, healthy, serving.child);
    check(serverImage() === 'api.exe', 'sipges-desktop serves the Go API');
    const stopped = await serving.stop();
    check(stopped.report?.sent === true && stopped.report?.exitCode === 0, `Ctrl+C: sipges-desktop exit 0 (got ${stopped.report?.exitCode}, ${stopped.report?.error ?? 'no error'})`);
    check(stopped.report.stdout.includes('PostgreSQL stopped'), 'sipges-desktop printed «PostgreSQL stopped»');
    check(!postgresRunning() && !existsSync(join(state, 'pg18', 'postmaster.pid')), 'no postgres.exe and no postmaster.pid left');
    check(portListeners().length === 0 && !(await healthy()), 'port 8000 is free');

    step('8. The original PGlite folder, and the way back to TypeScript');
    check(digest(await tree(pglite)) === pgliteDigest, 'the original PGlite folder is byte-identical after the whole Go rehearsal');
    ts = await startManaged('ts-start-2');
    check(serverImage() === 'node.exe', 'start.ps1 without -Go serves from node.exe again');
    await compare('back-to-typescript');
    await stopTree(ts, 'TypeScript version');
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
