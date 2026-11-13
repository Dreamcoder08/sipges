// The visit drill on a real Windows machine, with synthetic data only (closure-roadmap T33–T35):
//
//   node deploy/desktop/windows/drill.mjs [--work <new dir>] [--logs <dir>]
//        [--old-commit <commit>] [--launcher-commit <commit>]
//
// Run it from a checkout of the version to install, after `pnpm install --frozen-lockfile`, on a
// Windows computer or account that is NOT the laptop: .github/workflows/windows-desktop.yml runs
// it on windows-latest, and the owner can run the same drill by hand before the visit
// (docs/deployment/desktop-visit.es.md, «Ensayo en otra PC con Windows»). Nothing is published
// and no real key is used.
//
// 0. Checks (Node 24+, port 8000 free, Windows PowerShell), the SIPGES shortcuts of this account
//    are saved (restored at the end), and the scripts travel as the visit carries them: a zip of
//    deploy/desktop made with `git archive` and unpacked with Expand-Archive.
// 1. The laptop today: a clone of <old-commit> without its data/ folder, the clone-mode
//    install.ps1 of that time (from <launcher-commit> when the old commit predates the launchers),
//    with LOCALAPPDATA pointed at a scratch folder; started with its own start.ps1 on port 8000;
//    synthetic data through the public API (the seed of deploy/desktop/migration/rehearse.mjs);
//    snapshot.mjs; SIPGES ended the way the runbook does (the node process is ended).
// 2. A throwaway Ed25519 key made with the runbook's command, the package built with
//    deploy/desktop/package/builder.mjs and signed with deploy/desktop/updater/release.mjs.
// 3. The runbook's Copy-Item of the state folder, install.ps1 -Release <release> -State <copy>,
//    update.mjs --first-start, the installed start.ps1 (SIPGES_DESKTOP_NO_UI=1), compare.mjs:
//    `RESULT: no difference`; the original state folder stays byte-identical.
// 4. Update N -> N+1: a second package signed with the same key into <root>\releases, the
//    launcher offers it, an administrator asks for it through POST /system/desktop/update, the new
//    version runs and compare.mjs again finds no difference.
// 5. Halt: a fresh managed install whose update cannot be rolled back (the pre-update copy is
//    removed by an injected migration, as in the updater tests); update.mjs --recover exits 3 and
//    the installed start.ps1 exits 3 printing the notice. Rerunning install.ps1 (managed and
//    clone mode) then exits 1 with «Hay una actualización de SIPGES pendiente o detenida» and
//    changes nothing; the halt text start.ps1 falls back to names the recorded state folder.
// 6. Logs (launcher.log, update.log, update-boot.log, api.log, the outputs of every command) are
//    copied to --logs; never a state folder, a snapshot or the key. The key is deleted at the end.
//
// Every process it starts is ended on every way out (on Windows, the whole process tree).
/* global fetch, AbortSignal */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { release as osRelease, tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { StringDecoder } from 'node:string_decoder';
import process from 'node:process';
import console from 'node:console';
import { signIn } from '../migration/client.mjs';
import { LOGIN, analystSignsIn, digest, sameAccess, seed, tree } from '../migration/rehearse.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
// install.ps1, start.ps1 and start-managed.ps1 use this port; the drill refuses to run when it is busy.
const PORT = 8000;
const BASE = `http://127.0.0.1:${PORT}`;
const ALFA = 'SINTETICA/PRJ-ALFA';
const DEFAULT_OLD = 'e490339c';
// The first commit with deploy/desktop/windows/install.ps1; its parent is e490339c and it changed
// nothing under apps/ or packages/.
const DEFAULT_LAUNCHER = '6d867050';
const POWERSHELL = 'powershell.exe';
// A commit or ref name as git prints them; never an option (`-…`) or a range (`a..b`).
const COMMIT = /^(?!.*\.\.)[0-9A-Za-z][0-9A-Za-z._/-]{0,99}$/;
// What install.ps1 and start-managed.ps1 print with their accents: they write UTF-8 when their
// output is read through a pipe ([Console]::OutputEncoding), so the drill can check it as typed.
export const INSTALLED_LINE = 'SIPGES está instalado. Ábrelo desde el menú Inicio o el escritorio.';
export const HALT_LINE = 'SIPGES no se inició';
// install.ps1 during a pending or halted update; the halt text start-managed.ps1 shows when the
// launcher left no notice: naming the state folder of install.json, or for any install.
export const PENDING_LINE = 'Hay una actualización de SIPGES pendiente o detenida';
export const haltFallbackNamed = (state) =>
  `(la carpeta ${win32.basename(state)}.pre-update-… que está en ${win32.dirname(state)}, junto a su carpeta de datos ${state})`;
export const HALT_FALLBACK_GENERIC =
  '(la carpeta terminada en .pre-update-… que está junto a su carpeta de datos de SIPGES)';

const USAGE = `Usage: node deploy/desktop/windows/drill.mjs [--work <new dir>] [--logs <dir>] [--old-commit <commit>] [--launcher-commit <commit>]

The data-move, update and halt drill of the visit, on Windows, with synthetic data only.
Run it from the checkout to install, after pnpm install --frozen-lockfile, never on the laptop:
it needs port 8000 free and rewrites the SIPGES shortcuts of this Windows account while it runs
(they are put back at the end). Defaults: --work %TEMP%\\sipges-drill-<time>, --logs <work>\\logs,
--old-commit ${DEFAULT_OLD}, --launcher-commit ${DEFAULT_LAUNCHER} (used only when the old
commit has no deploy\\desktop\\windows\\install.ps1). Ends with DRILL PASSED, or DRILL FAILED and
exit code 1.`;

/** The drill's options, with a fresh work folder and two versions ordered N < N+1. */
export function parseOptions(args, { now = new Date(), tmp = tmpdir() } = {}) {
  const keys = {
    '--work': 'work',
    '--logs': 'logs',
    '--old-commit': 'oldCommit',
    '--launcher-commit': 'launcherCommit',
  };
  const given = {};
  for (let i = 0; i < args.length; i += 2) {
    const [key, value] = [args[i], args[i + 1]];
    if (!keys[key] || !value || value.startsWith('--') || given[keys[key]] !== undefined)
      throw new Error('Invalid options; use --help');
    given[keys[key]] = value;
  }
  for (const name of ['oldCommit', 'launcherCommit'])
    if (given[name] !== undefined && !COMMIT.test(given[name]))
      throw new Error(`Invalid commit: ${given[name]}`);
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const work = given.work ?? join(tmp, `sipges-drill-${stamp}`);
  const digits = stamp.replace(/\D/g, '');
  return {
    work,
    logs: given.logs ?? join(work, 'logs'),
    oldCommit: given.oldCommit ?? DEFAULT_OLD,
    launcherCommit: given.launcherCommit ?? DEFAULT_LAUNCHER,
    versions: [`0.0.7-drill.${digits}.1`, `0.0.7-drill.${digits}.2`],
  };
}

/**
 * The environment of every process the drill starts: no SIPGES_* variable from this shell, no
 * PSModulePath (one inherited from PowerShell 7 breaks Windows PowerShell 5.1), and the given
 * values, such as the scratch LOCALAPPDATA. Windows names are compared without case.
 */
export function childEnv(base, extra = {}) {
  const drop = new Set(['PSMODULEPATH', ...Object.keys(extra).map((key) => key.toUpperCase())]);
  const env = Object.fromEntries(
    Object.entries(base).filter(
      ([key]) => !key.toUpperCase().startsWith('SIPGES_') && !drop.has(key.toUpperCase()),
    ),
  );
  return { ...env, ...extra };
}

/** Process ids listening on a TCP port in `netstat -ano -p TCP` output, whatever its language. */
export function listeners(netstat, port) {
  const pids = [];
  for (const line of netstat.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+)\s+(\S+)\s+\S+\s+(\d+)\s*$/.exec(line);
    // A listening socket has no remote end: 0.0.0.0:0 or [::]:0. The state column is translated.
    if (!match || !match[1].endsWith(`:${port}`) || !match[2].endsWith(':0')) continue;
    const pid = Number(match[3]);
    if (pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

// ---------------------------------------------------------------------------------------------

let logFile = null;
const say = (line = '') => {
  console.log(line);
  if (logFile) appendFileSync(logFile, `${line}\n`);
};
const step = (title) => say(`\n== ${title}`);
function check(condition, label) {
  if (!condition) throw new Error(`Check failed: ${label}`);
  say(`ok - ${label}`);
}

/** Process trees started here and not ended yet (pid of their root). */
const trees = new Set();
const killTree = (pid) => {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  trees.delete(pid);
};
const portListeners = () =>
  listeners(spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout ?? '', PORT);

async function healthy() {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    await response.arrayBuffer();
    return response.status === 200;
  } catch {
    return false;
  }
}

async function waitFor(label, seconds, probe, child) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (child?.done)
      throw new Error(`${label}: the process ended first (exit code ${child.status})`);
    if (Date.now() > deadline) throw new Error(`${label}: not within ${seconds} s`);
    await sleep(1000);
  }
}

/**
 * Starts a command with its output streamed to the console (prefixed) and to `log`. Returns the
 * child with `ended` (resolves `{ status, output }`), `done` and `status`.
 */
function launch(command, args, { env, cwd = repo, log }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  trees.add(child.pid);
  let output = '';
  let pending = '';
  // One decoder per stream, so an accent split between two chunks is not cut in half; a UTF-8
  // byte order mark is not part of the output.
  const take = (decoder) => (chunk) => {
    const text = decoder.write(chunk).replace(/\ufeff/g, '');
    if (!text) return;
    output += text;
    if (log) appendFileSync(log, text);
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) say(`  | ${line}`);
  };
  child.stdout.on('data', take(new StringDecoder('utf8')));
  child.stderr.on('data', take(new StringDecoder('utf8')));
  child.ended = new Promise((resolveEnded) => {
    let finished = false;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      if (pending) say(`  | ${pending}`);
      pending = '';
      child.done = true;
      child.status = status;
      trees.delete(child.pid);
      resolveEnded({ status, output });
    };
    // A grandchild that kept a copy of the output pipe must not hold the drill: after the exit,
    // the output is waited for 5 s at most. (Referenced: the drill must not end while waiting.)
    child.on('exit', (code) =>
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }, 5000),
    );
    child.on('close', (code) => finish(code));
    child.on('error', (error) => {
      output += `${error.message}\n`;
      finish(null);
    });
  });
  return child;
}

/** Runs a command to its end; `seconds` bounds it (its whole tree is ended on time-out). */
async function run(command, args, { env, cwd, log, seconds } = {}) {
  const child = launch(command, args, { env: env ?? childEnv(process.env), cwd, log });
  if (!seconds) return child.ended;
  const timer = setTimeout(() => killTree(child.pid), seconds * 1000);
  const result = await child.ended;
  clearTimeout(timer);
  return result;
}

const psArgs = (file, args = []) => [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  file,
  ...args,
];
const node = (args, options) => run(process.execPath, args, options);
/**
 * A PowerShell 5.1 script written to the work folder, as the runbook's lines are typed. A UTF-8
 * BOM, so Windows PowerShell 5.1 reads any accent as the runbook prints it, and UTF-8 output, so
 * a folder named after the account reaches the drill as a console window shows it.
 */
async function psLines(work, name, lines, options) {
  const file = join(work, 'ps', `${name}.ps1`);
  mkdirSync(dirname(file), { recursive: true });
  const utf8 = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false';
  await writeFile(file, `\ufeff${[utf8, ...lines].join('\r\n')}\r\n`);
  return run(POWERSHELL, psArgs(file), options);
}
const quotePs = (text) => `'${text.replace(/'/g, "''")}'`;

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: repo, ...options });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').toString().trim()}`);
  return result.stdout;
}

/**
 * The scripts as the visit carries them (runbook section 1): `deploy/desktop` of the committed
 * HEAD in a zip, unpacked on the laptop with Expand-Archive. Uncommitted changes never travel.
 */
export function packScripts(zip, cwd = repo) {
  git(['archive', '--format=zip', '-o', zip, 'HEAD', 'deploy/desktop'], { cwd });
}

async function countFiles(dir) {
  const files = Object.keys(await tree(dir));
  let bytes = 0;
  for (const file of files) bytes += (await lstat(join(dir, file))).size;
  return { files: files.length, bytes };
}

/** The runbook's files/bytes line (Get-ChildItem -Recurse -File -Force) for each folder. */
const countLine = (dir) =>
  `foreach ($c in ${quotePs(dir)}) { $m = Get-ChildItem -Recurse -File -Force -LiteralPath $c | Measure-Object -Property Length -Sum; "$c  archivos: $($m.Count)  bytes: $($m.Sum)" }`;
const parseCount = (output) => {
  const match = /archivos: (\d+)\s+bytes: (\d+)/.exec(output);
  return match ? { files: Number(match[1]), bytes: Number(match[2]) } : null;
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
/** The JSON lines of a launcher log after byte `from`; a line still being written is skipped. */
const events = async (log, from = 0) =>
  (await readFile(log))
    .subarray(from)
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
const sizeOf = async (path) => (existsSync(path) ? (await lstat(path)).size : 0);

/** Ends every process listening on the port and waits until SIPGES no longer answers. */
async function endServer(label) {
  for (const pid of portListeners()) killTree(pid);
  await waitFor(
    `${label}: SIPGES still answers`,
    60,
    async () => !(await healthy()) && portListeners().length === 0,
  );
}

/**
 * The laptop today (step 1): a clone of `oldCommit` in <work>\old without its data/ folder, with
 * the clone-mode launcher of `launcherCommit` when the old commit predates the launchers.
 */
export function cloneOld({ work, oldCommit, launcherCommit }) {
  const sha = (commit) =>
    git(['rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
  const oldSha = sha(oldCommit);
  const old = join(work, 'old');
  git(['clone', '--no-checkout', '--quiet', repo, old]);
  git(['-C', old, 'update-ref', '--no-deref', 'HEAD', oldSha]);
  git(['-C', old, 'read-tree', 'HEAD']);
  const files = git(['-C', old, 'ls-files', '-z'], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter((file) => file && !file.startsWith('data/'));
  git(['-C', old, 'checkout-index', '-z', '--stdin'], { input: `${files.join('\0')}\0` });
  check(!existsSync(join(old, 'data')), 'the old clone has no data/ folder');
  if (existsSync(join(old, 'deploy', 'desktop', 'windows', 'install.ps1')))
    say(`${oldCommit} has its own clone-mode install.ps1: no launcher taken from elsewhere`);
  else {
    const launcherSha = sha(launcherCommit);
    const same = spawnSync(
      'git',
      [
        'diff',
        '--quiet',
        oldSha,
        launcherSha,
        '--',
        'apps',
        'packages',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
      ],
      { cwd: repo },
    );
    check(
      same.status === 0,
      `${launcherCommit} changes nothing the old API runs, so its launcher stands for the install of ${oldCommit}`,
    );
    const listed = git(
      ['ls-tree', '-r', '-z', '--name-only', launcherSha, '--', 'deploy/desktop'],
      { encoding: 'buffer' },
    )
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    for (const file of listed) {
      const target = join(old, ...file.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        git(['cat-file', 'blob', `${launcherSha}:${file}`], { encoding: 'buffer' }),
      );
    }
    say(
      `${oldCommit} has no desktop launcher: deploy/desktop taken from ${launcherCommit} (${listed.length} files)`,
    );
  }
  return old;
}

/** The Arguments line of each SIPGES shortcut (Start menu, Desktop), one per line. */
export const SHORTCUT_ARGS = [
  "foreach ($f in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) { (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $f 'SIPGES.lnk')).Arguments }",
];

/** Copies each existing SIPGES.lnk of `folders` to <saved>\<index>.lnk. */
export function saveShortcuts(folders, saved) {
  mkdirSync(saved, { recursive: true });
  for (const [index, folder] of folders.entries())
    if (existsSync(join(folder, 'SIPGES.lnk')))
      copyFileSync(join(folder, 'SIPGES.lnk'), join(saved, `${index}.lnk`));
}

/** Puts back what saveShortcuts saved, and removes a SIPGES.lnk that did not exist then. */
export function restoreShortcuts(folders, saved) {
  for (const [index, folder] of folders.entries()) {
    const link = join(folder, 'SIPGES.lnk');
    const copy = join(saved, `${index}.lnk`);
    try {
      if (existsSync(copy)) copyFileSync(copy, link);
      else if (existsSync(link)) rmSync(link);
    } catch (error) {
      say(`could not put back ${link}: ${error.message}`);
    }
  }
}

// Shared with the laptop-kit rehearsal (laptop-kit.mjs), which runs in its own process.
export const setLog = (file) => {
  logFile = file;
};
export {
  BASE,
  PORT,
  POWERSHELL,
  check,
  countLine,
  endServer,
  git,
  healthy,
  killTree,
  launch,
  node as runNode,
  parseCount,
  portListeners,
  psArgs,
  psLines,
  quotePs,
  readJson,
  run,
  say,
  step,
  trees,
  waitFor,
};

// ---------------------------------------------------------------------------------------------

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(USAGE);
  const options = parseOptions(args);
  if (process.platform !== 'win32')
    throw new Error(
      'the Windows drill runs on Windows only; on Linux use deploy/desktop/migration/rehearse.mjs',
    );
  const { work, logs, versions } = options;
  const [N, N1] = versions;
  if (existsSync(work) && readdirSync(work).length > 0)
    throw new Error(`${work} already exists and is not empty`);
  mkdirSync(work, { recursive: true });
  mkdirSync(logs, { recursive: true });
  logFile = join(logs, 'drill.txt');
  const out = (name) => join(logs, `${name}.txt`);
  const lad = join(work, 'LocalAppData');
  const env = childEnv(process.env, { LOCALAPPDATA: lad });
  const original = join(lad, 'SIPGES');
  const moved = join(lad, 'SIPGES-datos');
  const appRoot = join(lad, 'SIPGES-app');
  const haltLad = join(work, 'halt', 'LocalAppData');
  const haltRoot = join(haltLad, 'SIPGES-app');
  const keyDir = join(work, 'key');
  const saved = join(work, 'shortcuts-saved');
  let folders = [];
  const collected = [];
  let managed;

  const collectLogs = () => {
    for (const [from, name] of [
      [join(original, 'api.log'), 'old-api.log'],
      [join(appRoot, 'launcher.log'), 'managed-launcher.log'],
      [join(appRoot, 'update.log'), 'managed-update.log'],
      [join(appRoot, 'update-boot.log'), 'managed-update-boot.log'],
      [join(haltRoot, 'launcher.log'), 'halt-launcher.log'],
      [join(haltRoot, 'update.log'), 'halt-update.log'],
    ])
      if (existsSync(from)) {
        copyFileSync(from, join(logs, name));
        collected.push(name);
      }
  };
  const cleanUp = () => {
    for (const pid of [...trees]) killTree(pid);
    for (const pid of portListeners()) killTree(pid);
    restoreShortcuts(folders, saved);
    rmSync(keyDir, { recursive: true, force: true });
    collectLogs();
  };
  let cleaned = false;
  const cleanUpOnce = () => {
    if (cleaned) return;
    cleaned = true;
    cleanUp();
  };
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      say(`\n${signal}: ending every process of the drill`);
      cleanUpOnce();
      process.exit(130);
    });

  try {
    step('0. Checks, shortcuts saved, scripts as the visit carries them');
    const major = Number(process.versions.node.split('.')[0]);
    check(major >= 24, `Node.js ${process.versions.node} (24 or later)`);
    check(
      existsSync(join(repo, 'node_modules', 'typescript')),
      'this checkout is installed (pnpm install --frozen-lockfile)',
    );
    check(portListeners().length === 0 && !(await healthy()), `nothing listens on port ${PORT}`);
    const head = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    say(`checkout ${head}; Windows ${osRelease()}; work folder ${work}`);
    // Written to a UTF-8 file: a redirected Windows PowerShell 5.1 prints in the console code
    // page, which would garble a folder named after the account.
    const factsFile = join(work, 'environment.txt');
    const facts = await psLines(
      work,
      'environment',
      [
        `[IO.File]::WriteAllLines(${quotePs(factsFile)}, [string[]]@($PSVersionTable.PSVersion.ToString(), [string](Get-ItemProperty HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem).LongPathsEnabled, [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')))`,
      ],
      { env, log: out('environment') },
    );
    check(facts.status === 0 && existsSync(factsFile), 'Windows PowerShell answers');
    const [psVersion, longPaths, ...shortcutFolders] = (await readFile(factsFile, 'utf8'))
      .replace(/^\ufeff/, '')
      .split(/\r?\n/)
      .map((line) => line.trim());
    check(psVersion.startsWith('5.'), `Windows PowerShell ${psVersion}`);
    say(`LongPathsEnabled: ${longPaths || '(not set)'}`);
    const found = shortcutFolders.filter(Boolean);
    check(
      found.length === 2 && found.every((folder) => existsSync(folder)),
      'the Start menu and Desktop folders exist',
    );
    saveShortcuts(found, saved);
    // Only once every existing shortcut is saved may the clean-up put them back or remove new ones.
    folders = found;
    say(`shortcuts saved from ${folders.join(', ')} (${readdirSync(saved).length} existed)`);
    const zip = join(work, 'sipges-scripts.zip');
    packScripts(zip);
    const unpacked = join(work, 'scripts');
    const expand = await psLines(
      work,
      'expand',
      [`Expand-Archive -LiteralPath ${quotePs(zip)} -DestinationPath ${quotePs(unpacked)}`],
      { env, log: out('expand') },
    );
    const scripts = join(unpacked, 'deploy', 'desktop');
    check(
      expand.status === 0 && existsSync(join(scripts, 'windows', 'install.ps1')),
      'git archive zip unpacked with Expand-Archive',
    );

    step(`1. The laptop today: clone install of ${options.oldCommit}, synthetic data, snapshot`);
    const old = cloneOld({
      work,
      oldCommit: options.oldCommit,
      launcherCommit: options.launcherCommit,
    });
    mkdirSync(lad, { recursive: true });
    const oldInstall = await run(
      POWERSHELL,
      psArgs(join(old, 'deploy', 'desktop', 'windows', 'install.ps1')),
      { env, log: out('old-install') },
    );
    check(oldInstall.status === 0, 'clone-mode install.ps1 exit 0');
    for (const name of ['data-key', 'admin-password'])
      check(
        (await readFile(join(original, name), 'utf8')).trim() !== '',
        `${name} made in %LOCALAPPDATA%\\SIPGES`,
      );
    const oldLinks = await psLines(work, 'shortcuts-old', SHORTCUT_ARGS, {
      env,
      log: out('shortcuts'),
    });
    check(
      oldLinks.output
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.trim().endsWith('\\deploy\\desktop\\windows\\start.ps1"')).length === 2,
      'both shortcuts open the clone start.ps1',
    );
    const oldStart = await run(
      POWERSHELL,
      psArgs(join(old, 'deploy', 'desktop', 'windows', 'start.ps1')),
      { env, log: out('old-start'), seconds: 240 },
    );
    check(oldStart.status === 0, 'the clone start.ps1 started the server and ended (exit 0)');
    check(await healthy(), `${BASE}/health answers`);
    const secrets = await seed(BASE, original, work);
    say(
      'synthetic data seeded: 2 projects, records, links, uploads, admin with MFA, a second account',
    );
    const analystBefore = await analystSignsIn(BASE, secrets.analystPassword);
    check(
      analystBefore.status === 200 && analystBefore.projects >= 1,
      `the second account opens ${analystBefore.projects} project(s) on the old version`,
    );
    const before = join(work, 'sipges-antes.json');
    const snapshot = await node(
      [
        join(scripts, 'migration', 'snapshot.mjs'),
        '--url',
        BASE,
        '--out',
        before,
        ...LOGIN(secrets, original),
      ],
      { log: out('snapshot') },
    );
    check(snapshot.status === 0 && snapshot.output.includes('Written:'), 'snapshot.mjs exit 0');
    check(
      !/not fully checked/.test(snapshot.output),
      'no part of the snapshot is (not fully checked)',
    );
    await endServer('old version');
    say('old version ended (its node process, as the runbook does in Task Manager)');
    const originalDigest = digest(await tree(original));
    const originalCount = await countFiles(original);
    const counted = await psLines(work, 'count-original', [countLine(original)], {
      env,
      log: out('counts'),
    });
    check(
      JSON.stringify(parseCount(counted.output)) === JSON.stringify(originalCount),
      `the runbook count of the original folder: ${originalCount.files} files, ${originalCount.bytes} bytes`,
    );

    step('2. Throwaway key, package N and its signed release');
    mkdirSync(keyDir, { recursive: true });
    const key = join(keyDir, 'sipges-clave-actualizaciones.pem');
    const made = await psLines(
      work,
      'key',
      [
        `node -e "const c=require('crypto');require('fs').writeFileSync(process.argv[1],c.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx'})" ${quotePs(key)}`,
      ],
      { env, log: out('key') },
    );
    check(
      made.status === 0 && existsSync(key),
      "the runbook's key command made a throwaway Ed25519 key",
    );
    const packages = join(repo, '.data', 'desktop-packages');
    const build = async (version) => {
      const dir = join(packages, `sipges-${version}`);
      const built = await node(
        [
          join(repo, 'deploy', 'desktop', 'package', 'builder.mjs'),
          '--version',
          version,
          '--out',
          dir,
        ],
        { log: out(`build-${version}`) },
      );
      check(
        built.status === 0 && built.output.includes(`Package created: ${dir}`),
        `builder.mjs built ${version}`,
      );
      return dir;
    };
    const sign = async (version, packageDir, releaseDir, notes) => {
      const signed = await node(
        [
          join(repo, 'deploy', 'desktop', 'updater', 'release.mjs'),
          '--package',
          packageDir,
          '--out',
          releaseDir,
          '--key',
          key,
          '--notes',
          notes,
        ],
        { log: out(`release-${version}`) },
      );
      check(
        signed.status === 0 && signed.output.includes(`Release ${version} signed: ${releaseDir}`),
        `release.mjs signed ${version}`,
      );
    };
    const releaseN = join(work, 'usb', `release-${N}`);
    mkdirSync(dirname(releaseN), { recursive: true });
    await sign(N, await build(N), releaseN, 'Versión definitiva (ensayo sintético en Windows).');
    const print = await psLines(
      work,
      'fingerprint',
      [
        `node -e "const c=require('crypto');console.log(c.createHash('sha256').update(c.createPublicKey(require('fs').readFileSync(process.argv[1])).export({type:'spki',format:'der'})).digest('hex'))" ${quotePs(join(releaseN, 'package', 'update-public-key.pem'))}`,
      ],
      { env, log: out('fingerprint') },
    );
    const fingerprint = /\b[0-9a-f]{64}\b/.exec(print.output)?.[0];
    check(
      print.status === 0 && Boolean(fingerprint),
      "the runbook's fingerprint command printed a SHA-256",
    );

    step('3. The runbook: copy of the data, managed install on the copy, first start, comparison');
    const copied = await psLines(
      work,
      'copy',
      [
        'Copy-Item -Recurse "$env:LOCALAPPDATA\\SIPGES" "$env:LOCALAPPDATA\\SIPGES-datos"',
        countLine(original),
        countLine(moved),
      ],
      { env, log: out('copy') },
    );
    const lines = copied.output.split(/\r?\n/).filter((line) => line.includes('archivos:'));
    check(
      copied.status === 0 &&
        lines.length === 2 &&
        JSON.stringify(parseCount(lines[0])) === JSON.stringify(parseCount(lines[1])),
      'Copy-Item: the two count lines are equal',
    );
    check(
      digest(await tree(moved)) === originalDigest,
      'the copy is byte-identical to the original',
    );
    const install = await run(
      POWERSHELL,
      psArgs(join(scripts, 'windows', 'install.ps1'), ['-Release', releaseN, '-State', moved]),
      { env, log: out('managed-install') },
    );
    check(install.status === 0, 'install.ps1 -Release -State exit 0');
    check(
      install.output.includes(
        `Trusting the update key that signed this release (SHA-256 ${fingerprint}).`,
      ),
      'the installer prints the fingerprint the runbook computed',
    );
    check(install.output.includes(`Installed ${N}`), `Installed ${N}`);
    check(
      install.output.includes(INSTALLED_LINE),
      `the installer's accents arrive as typed: «${INSTALLED_LINE.split('.')[0]}»`,
    );
    check(
      (await readJson(join(appRoot, 'install.json'))).stateDir.endsWith('SIPGES-datos'),
      'install.json stateDir ends in SIPGES-datos',
    );
    const newLinks = await psLines(work, 'shortcuts-new', SHORTCUT_ARGS, {
      env,
      log: out('shortcuts'),
    });
    check(
      newLinks.output
        .trim()
        .split(/\r?\n/)
        .filter((l) => l.trim().endsWith('\\SIPGES-app\\start.ps1"')).length === 2,
      'both shortcuts open SIPGES-app\\start.ps1',
    );
    const updateCli = (version) => join(appRoot, 'versions', version, 'updater', 'update.mjs');
    const first = await node([updateCli(N), '--install', appRoot, '--first-start'], {
      log: out('first-start'),
    });
    check(
      first.status === 0 &&
        new RegExp(
          `First start of ${N.replace(/\./g, '\\.')} done\\. Pre-update copy: .*SIPGES-datos\\.pre-update-.*-first-start-`,
        ).test(first.output),
      'update.mjs --first-start exit 0 with its dated pre-update copy',
    );

    const startManaged = async (name) => {
      const child = launch(POWERSHELL, psArgs(join(appRoot, 'start.ps1')), {
        env: { ...env, SIPGES_DESKTOP_NO_UI: '1' },
        log: out(name),
      });
      await waitFor('the managed start', 240, healthy, child);
      say('managed SIPGES answers on port 8000');
      return child;
    };
    const stopManaged = async (child) => {
      killTree(child.pid);
      await endServer('managed version');
      await child.ended;
    };
    const compare = async (label) => {
      const result = await node(
        [
          join(scripts, 'migration', 'compare.mjs'),
          '--before',
          before,
          '--url',
          BASE,
          ...LOGIN(secrets, moved),
        ],
        { log: out(`compare-${label}`) },
      );
      check(
        result.status === 0 && result.output.includes('RESULT: no difference'),
        `compare.mjs: RESULT: no difference (${label})`,
      );
      check(
        !/not (fully )?checked/.test(result.output),
        `compare.mjs: every part checked (${label})`,
      );
    };
    managed = await startManaged('managed-start-1');
    await compare('first-start');
    check(
      sameAccess(analystBefore, await analystSignsIn(BASE, secrets.analystPassword)),
      'the second account signs in and opens the same projects',
    );
    check(
      digest(await tree(original)) === originalDigest,
      'the original state folder is byte-identical',
    );
    await stopManaged(managed);

    step(`4. Update ${N} -> ${N1} through the notice`);
    const releaseN1 = join(appRoot, 'releases', `release-${N1}`);
    await sign(N1, await build(N1), releaseN1, 'Actualización de ensayo sintético en Windows.');
    const launcherLog = join(appRoot, 'launcher.log');
    const from = await sizeOf(launcherLog);
    managed = await startManaged('managed-start-2');
    const offered = await waitFor('the update check', 180, async () =>
      (await events(launcherLog, from)).find(
        (e) => e.event === 'update_check' || e.event === 'update_check_failed',
      ),
    );
    check(
      offered.event === 'update_check' && offered.available === N1,
      `the launcher offers ${N1} (${JSON.stringify(offered)})`,
    );
    const status = await readJson(join(appRoot, 'update-channel', 'status.json'));
    check(
      status.installed === N && status.available?.version === N1,
      'status.json: installed N, available N+1',
    );
    const password = (await readFile(join(moved, 'admin-password'), 'utf8')).trim();
    const totpSecret = (await readFile(secrets.secretFile, 'utf8')).trim();
    const admin = await signIn({
      base: BASE,
      username: 'admin',
      password,
      totpSecret,
      totpState: secrets.totpState,
    });
    const shown = await admin.call('/system/desktop/update', { scope: ALFA });
    const notice = shown.status === 200 ? await shown.json() : { status: shown.status };
    check(
      notice.installed === N && notice.available === N1,
      `GET /system/desktop/update: ${JSON.stringify({ installed: notice.installed, available: notice.available })}`,
    );
    const asked = await admin.call('/system/desktop/update', { scope: ALFA, method: 'POST' });
    const started = asked.status === 202 ? await asked.json() : { status: asked.status };
    check(
      started.status === 'restarting' && started.version === N1,
      `POST /system/desktop/update: 202 restarting ${N1}`,
    );
    const outcome = await waitFor(
      'the update',
      900,
      async () =>
        (await events(launcherLog, from)).find((e) =>
          [
            'updated',
            'update_failed',
            'start_failed',
            'update_request_refused',
            'update_request_ignored',
            'update_cancelled',
          ].includes(e.event),
        ),
      managed,
    );
    check(
      outcome.event === 'updated' && outcome.to === N1,
      `the launcher updated to ${N1} (${JSON.stringify(outcome)})`,
    );
    await waitFor('SIPGES after the update', 240, healthy, managed);
    check((await readJson(join(appRoot, 'current.json'))).version === N1, `current.json: ${N1}`);
    await compare('after-update');
    check(
      digest(await tree(original)) === originalDigest,
      'the original state folder is still byte-identical',
    );
    await stopManaged(managed);

    step('5. Halt: an update that cannot be rolled back stops SIPGES with exit code 3');
    mkdirSync(haltLad, { recursive: true });
    const haltEnv = childEnv(process.env, { LOCALAPPDATA: haltLad });
    const haltInstall = await run(
      POWERSHELL,
      psArgs(join(scripts, 'windows', 'install.ps1'), ['-Release', releaseN]),
      { env: haltEnv, log: out('halt-install') },
    );
    check(haltInstall.status === 0, 'a fresh managed install (install.ps1 -Release) exit 0');
    const { update } = await import(
      pathToFileURL(join(haltRoot, 'versions', N, 'updater', 'updater.mjs')).href
    );
    // As updater.test.mjs does: the migration removes the pre-update copy and fails, so the
    // rollback has nothing to restore from.
    const wreck = async ({ stateDir }) => {
      for (const name of await readdir(dirname(stateDir)))
        if (name.includes('.pre-update-'))
          await rm(join(dirname(stateDir), name), { recursive: true });
      throw new Error('synthetic migration failure (Windows drill)');
    };
    const halted = await update({
      root: haltRoot,
      release: releaseN1,
      migrate: wreck,
      ready: async () => {},
    }).then(
      () => null,
      (error) => error,
    );
    check(
      halted?.code === 'ROLLBACK_INCOMPLETE',
      `the injected failure leaves ROLLBACK_INCOMPLETE (${halted?.code ?? 'no error'})`,
    );
    const recover = await node(
      [join(haltRoot, 'versions', N, 'updater', 'update.mjs'), '--install', haltRoot, '--recover'],
      { log: out('halt-recover') },
    );
    check(recover.status === 3, `update.mjs --recover exit 3 (got ${recover.status})`);
    const haltStart = await run(POWERSHELL, psArgs(join(haltRoot, 'start.ps1')), {
      env: { ...haltEnv, SIPGES_DESKTOP_NO_UI: '1' },
      log: out('halt-start'),
      seconds: 180,
    });
    check(haltStart.status === 3, `the installed start.ps1 exit 3 (got ${haltStart.status})`);
    check(
      haltStart.output.includes(HALT_LINE) && haltStart.output.includes('.pre-update-'),
      `start.ps1 printed the halt notice («${HALT_LINE}…») naming the pre-update copy`,
    );
    const refused = (await events(join(haltRoot, 'launcher.log'))).find(
      (e) => e.event === 'start_refused',
    );
    check(
      refused?.code === 'ROLLBACK_INCOMPLETE',
      'launcher.log: start_refused ROLLBACK_INCOMPLETE',
    );
    check(!(await healthy()), 'nothing answers on port 8000 after the halt');

    step('5b. During the halt the installer creates nothing; the fallback names the state folder');
    const haltState = JSON.parse(await readFile(join(haltRoot, 'install.json'), 'utf8')).stateDir;
    const journal = join(haltRoot, 'update-journal.json');
    const pendingJournal = await readFile(journal);
    const stateDigest = digest(await tree(haltState));
    const besideState = readdirSync(dirname(haltState)).sort().join('|');
    const inRoot = readdirSync(haltRoot).sort().join('|');
    for (const [mode, args] of [
      ['managed', ['-Release', releaseN]],
      ['clone', []],
    ]) {
      const rerun = await run(POWERSHELL, psArgs(join(scripts, 'windows', 'install.ps1'), args), {
        env: haltEnv,
        log: out(`halt-install-rerun-${mode}`),
        seconds: 120,
      });
      check(rerun.status === 1, `install.ps1 (${mode}) during the halt exit 1 (got ${rerun.status})`);
      check(
        rerun.output.includes(`${PENDING_LINE} (${journal})`),
        `install.ps1 (${mode}) printed «${PENDING_LINE} (…)»`,
      );
      check(
        (await readFile(journal)).equals(pendingJournal) &&
          digest(await tree(haltState)) === stateDigest &&
          readdirSync(dirname(haltState)).sort().join('|') === besideState &&
          readdirSync(haltRoot).sort().join('|') === inRoot,
        `install.ps1 (${mode}) changed nothing: journal, state folder, its siblings, install root`,
      );
    }
    // Get-HaltFallback of the installed start.ps1, run on its own: start.ps1 shows it only when
    // the launcher's notice is missing from launcher.log, which the halt above always writes.
    const fallbackOf = (name, startPs1) =>
      psLines(
        work,
        name,
        [
          "$ErrorActionPreference = 'Stop'",
          `$path = ${quotePs(startPs1)}`,
          '$Root = Split-Path -Parent $path',
          '$ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$null)',
          'foreach ($statement in $ast.EndBlock.Statements) {',
          "    $assigned = ($statement -is [System.Management.Automation.Language.AssignmentStatementAst]) -and (@('$HaltNamed', '$HaltGeneric') -contains $statement.Left.Extent.Text)",
          "    $defined = ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($statement.Name -eq 'Get-HaltFallback')",
          '    if ($assigned -or $defined) { . ([scriptblock]::Create($statement.Extent.Text)) }',
          '}',
          'Write-Output (Get-HaltFallback)',
        ],
        { log: out(name), seconds: 60 },
      );
    const named = await fallbackOf('halt-fallback-named', join(haltRoot, 'start.ps1'));
    check(
      named.status === 0 &&
        named.output.trim().startsWith(HALT_LINE) &&
        named.output.includes(haltFallbackNamed(haltState)),
      `the fallback halt text names the managed state folder ${haltState}`,
    );
    const bare = join(work, 'halt-fallback-generic');
    mkdirSync(bare, { recursive: true });
    copyFileSync(join(haltRoot, 'start.ps1'), join(bare, 'start.ps1'));
    const generic = await fallbackOf('halt-fallback-generic', join(bare, 'start.ps1'));
    check(
      generic.status === 0 &&
        generic.output.trim().startsWith(HALT_LINE) &&
        generic.output.includes(HALT_FALLBACK_GENERIC),
      'without install.json the fallback halt text is the generic one',
    );

    say('\nDRILL PASSED');
  } finally {
    cleanUpOnce();
    say(`logs copied to ${logs}: ${collected.join(', ') || 'none'}`);
    say(`work folder kept (synthetic data only): ${work}; the throwaway key was deleted`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const line = `DRILL FAILED: ${error.message}`;
    console.error(line);
    if (logFile) appendFileSync(logFile, `${line}\n`);
    process.exitCode = 1;
  });
}
