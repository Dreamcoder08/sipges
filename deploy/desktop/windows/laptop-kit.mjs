// The kit built on the laptop itself, rehearsed on Windows with synthetic data only
// (docs/deployment/desktop-visit.es.md, «Armar el kit en la laptop»):
//
//   node deploy/desktop/windows/laptop-kit.mjs [--work <new dir>] [--logs <dir>]
//        [--old-commit <commit>] [--launcher-commit <commit>]
//
// Run it from a checkout of the definitive commit on a Windows computer or account that is NOT
// the laptop: .github/workflows/windows-desktop.yml (job laptop-kit) runs it on windows-latest.
// It reuses the pieces of drill.mjs and needs no `pnpm install` of this checkout, only pnpm 12.
//
// 0. Checks (Node 24+, port 8000 free) and the SIPGES shortcuts of this account saved (put back
//    at the end).
// 1. The laptop today: the clone-mode install of <old-commit> (as drill.mjs does), with
//    LOCALAPPDATA pointed at a scratch folder; its shortcuts open the old clone. The old clone's
//    tracked files are hashed.
// 2. The second clone: `git clone` of this commit into <work>\SIPGES-kit and
//    `pnpm install --frozen-lockfile` there, timed and measured.
// 3. SIPGES open: the old version started with its own start.ps1, synthetic data through the
//    public API, snapshot.mjs. visit-kit.mjs refuses --out inside the old clone and, while SIPGES
//    answers, refuses to build; neither writes anything.
// 4. SIPGES closed: visit-kit.mjs from the second clone, the key in a «key USB» folder and --out
//    in a separate laptop folder (one USB only). The build is timed and measured against the free
//    space the kit and the runbook ask for. The old clone's tracked files are byte-identical, its
//    shortcuts still open it, and the SIPGES folders of LOCALAPPDATA did not change.
// 5. The runbook from the kit: the scripts unpacked from its zip, the Copy-Item of the state
//    folder, install.ps1 -Release <kit release> -State <copy> (the fingerprint of fingerprint.txt;
//    the shortcuts now open SIPGES-app), update.mjs --first-start, the installed start.ps1 and
//    compare.mjs: `RESULT: no difference`; the original state folder and the old clone unchanged.
// 6. Logs and measures (measures.txt, and the job summary on GitHub) are copied to --logs; never a
//    state folder, a snapshot or the key. The key is deleted at the end.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { LOGIN, analystSignsIn, digest, sameAccess, seed, tree } from '../migration/rehearse.mjs';
import {
  BASE,
  INSTALLED_LINE,
  POWERSHELL,
  SHORTCUT_ARGS,
  check,
  childEnv,
  cloneOld,
  countLine,
  endServer,
  git,
  healthy,
  killTree,
  launch,
  parseCount,
  parseOptions,
  portListeners,
  psArgs,
  psLines,
  quotePs,
  restoreShortcuts,
  run,
  runNode,
  saveShortcuts,
  say,
  setLog,
  step,
  trees,
  waitFor,
} from './drill.mjs';
import {
  BUILD_FREE,
  KIT_FREE,
  LAPTOP_FREE_GB,
  SCRIPTS_ZIP,
  VISIT_FOLDER,
  opensCheckout,
} from './visit-kit.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
export const PASSED = 'LAPTOP KIT REHEARSAL PASSED';
let logPath = null;

const USAGE = `Usage: node deploy/desktop/windows/laptop-kit.mjs [--work <new dir>] [--logs <dir>] [--old-commit <commit>] [--launcher-commit <commit>]

Rehearses building the visit kit on the laptop, on Windows, with synthetic data only: the clone
install of <old-commit>, a second clone of this commit, visit-kit.mjs there (its refusals first),
and the install from the kit. Never on the laptop: it needs port 8000 free and rewrites the SIPGES
shortcuts of this Windows account while it runs (they are put back at the end). Ends with
${PASSED}, or LAPTOP KIT REHEARSAL FAILED and exit code 1.`;

/** Bytes of the regular files under `dir`; links and junctions are not followed. */
export async function bytesOf(dir) {
  let bytes = 0;
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) bytes += (await lstat(full)).size;
    }
  };
  if (existsSync(dir)) await walk(dir);
  return bytes;
}

/**
 * A digest of the tracked files of a clone as they are on disk (git ls-files reads the index and
 * writes nothing; a tracked file that is not checked out, such as data/, is left out).
 */
export async function trackedDigest(clone) {
  const files = git(['-C', clone, 'ls-files', '-z'], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  const hashes = {};
  for (const file of files) {
    const full = join(clone, ...file.split('/'));
    const stats = await lstat(full).catch(() => null);
    if (stats?.isFile()) hashes[file] = createHash('sha256').update(await readFile(full)).digest('hex');
  }
  return { files: Object.keys(hashes).length, digest: digest(hashes) };
}

const mb = (bytes) => `${Math.round(bytes / MiB)} MB`;

/**
 * Why the measured sizes leave less than twice the room the kit and the runbook ask for, one
 * line each; empty when they fit. Sizes in bytes: the clone, what pnpm install added, what the
 * kit added to the clone (the package, apps\web\dist) and the signed release in --out.
 */
export function checkMeasures({ cloneBytes, installBytes, buildBytes, releaseBytes }) {
  const failures = [];
  if (buildBytes * 2 > BUILD_FREE)
    failures.push(
      `the build added ${mb(buildBytes)} to the clone, more than half of BUILD_FREE (${mb(BUILD_FREE)}) in visit-kit.mjs: raise it`,
    );
  if (releaseBytes * 2 > KIT_FREE)
    failures.push(
      `the signed release is ${mb(releaseBytes)}, more than half of KIT_FREE (${mb(KIT_FREE)}) in visit-kit.mjs: raise it`,
    );
  const total = cloneBytes + installBytes + buildBytes + releaseBytes;
  if (total * 2 > LAPTOP_FREE_GB * GiB)
    failures.push(
      `clone, install, build and kit take ${mb(total)}, more than half of LAPTOP_FREE_GB (${LAPTOP_FREE_GB} GB): raise it in visit-kit.mjs and the runbook`,
    );
  return failures;
}

/** The measures as lines for measures.txt and the job summary. */
export function measureLines({ seconds, cloneBytes, installBytes, buildBytes, releaseBytes }) {
  const minutes = (s) => `${(s / 60).toFixed(1)} min`;
  return [
    `git clone: ${minutes(seconds.clone)}, ${mb(cloneBytes)}`,
    `pnpm install --frozen-lockfile: ${minutes(seconds.install)}, ${mb(installBytes)}`,
    `visit-kit.mjs: ${minutes(seconds.kit)}, ${mb(buildBytes)} in the clone, ${mb(releaseBytes)} signed release`,
    `total: ${minutes(seconds.clone + seconds.install + seconds.kit)}, ${mb(cloneBytes + installBytes + buildBytes + releaseBytes)} (the runbook asks ${LAPTOP_FREE_GB} GB free)`,
  ];
}

// ---------------------------------------------------------------------------------------------

const elapsed = (from) => (Date.now() - from) / 1000;
/** The SIPGES* folders of a LOCALAPPDATA, by name, each with its content digest. */
async function sipgesFolders(lad) {
  const found = {};
  for (const name of readdirSync(lad).sort())
    if (name.toLowerCase().startsWith('sipges')) found[name] = digest(await tree(join(lad, name)));
  return JSON.stringify(found);
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(USAGE);
  const options = parseOptions(args);
  if (process.platform !== 'win32')
    throw new Error('the laptop-kit rehearsal runs on Windows only');
  const { work, logs } = options;
  const version = options.versions[0];
  if (existsSync(work) && readdirSync(work).length > 0)
    throw new Error(`${work} already exists and is not empty`);
  mkdirSync(work, { recursive: true });
  mkdirSync(logs, { recursive: true });
  logPath = join(logs, 'laptop-kit.txt');
  setLog(logPath);
  const out = (name) => join(logs, `${name}.txt`);
  const lad = join(work, 'LocalAppData');
  const env = childEnv(process.env, { LOCALAPPDATA: lad });
  const original = join(lad, 'SIPGES');
  const moved = join(lad, 'SIPGES-datos');
  const appRoot = join(lad, 'SIPGES-app');
  const kit = join(work, 'SIPGES-kit');
  const keyUsb = join(work, 'K');
  const key = join(keyUsb, 'sipges-clave-actualizaciones.pem');
  const salida = join(work, 'SIPGES-kit-salida');
  const saved = join(work, 'shortcuts-saved');
  let folders = [];
  const collected = [];

  const cleanUp = () => {
    for (const pid of [...trees]) killTree(pid);
    for (const pid of portListeners()) killTree(pid);
    restoreShortcuts(folders, saved);
    rmSync(keyUsb, { recursive: true, force: true });
    for (const [from, name] of [
      [join(original, 'api.log'), 'old-api.log'],
      [join(appRoot, 'launcher.log'), 'managed-launcher.log'],
      [join(appRoot, 'update.log'), 'managed-update.log'],
      [join(appRoot, 'update-boot.log'), 'managed-update-boot.log'],
    ])
      if (existsSync(from)) {
        copyFileSync(from, join(logs, name));
        collected.push(name);
      }
  };
  let cleaned = false;
  const cleanUpOnce = () => {
    if (cleaned) return;
    cleaned = true;
    cleanUp();
  };
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      say(`\n${signal}: ending every process of the rehearsal`);
      cleanUpOnce();
      process.exit(130);
    });

  const shortcutLines = async (name) =>
    (await psLines(work, name, SHORTCUT_ARGS, { env, log: out('shortcuts') })).output
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const openOld = async (name, old) => {
    const lines = await shortcutLines(name);
    return lines.length === 2 && lines.every((line) => opensCheckout(line, old));
  };
  const kitRun = (name, outDir) =>
    runNode(
      [
        join(kit, 'deploy', 'desktop', 'windows', 'visit-kit.mjs'),
        '--version',
        version,
        '--key',
        key,
        '--out',
        outDir,
      ],
      { env, cwd: kit, log: out(name) },
    );

  try {
    step('0. Checks and the SIPGES shortcuts of this account saved');
    const major = Number(process.versions.node.split('.')[0]);
    check(major >= 24, `Node.js ${process.versions.node} (24 or later)`);
    check(portListeners().length === 0 && !(await healthy()), 'nothing listens on port 8000');
    const head = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    say(`checkout ${head}; work folder ${work}`);
    const foldersFile = join(work, 'shortcut-folders.txt');
    const listed = await psLines(
      work,
      'folders',
      [
        `[IO.File]::WriteAllLines(${quotePs(foldersFile)}, [string[]]@([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')))`,
      ],
      { env, log: out('environment') },
    );
    const found = (await readFile(foldersFile, 'utf8'))
      .replace(/^\ufeff/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    check(
      listed.status === 0 && found.length === 2 && found.every((folder) => existsSync(folder)),
      'the Start menu and Desktop folders exist',
    );
    saveShortcuts(found, saved);
    folders = found;

    step(`1. The laptop today: clone install of ${options.oldCommit} and its shortcuts`);
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
    check(await openOld('shortcuts-old', old), 'both shortcuts open the old clone start.ps1');
    const oldFiles = await trackedDigest(old);
    say(`old clone: ${oldFiles.files} tracked files, digest ${oldFiles.digest}`);
    const oldUnchanged = async (when) => {
      const now = await trackedDigest(old);
      check(
        now.files === oldFiles.files && now.digest === oldFiles.digest,
        `the old clone's ${oldFiles.files} tracked files are byte-identical ${when}`,
      );
    };

    step('2. A second clone of this commit in its own folder, installed');
    let from = Date.now();
    git(['clone', '--no-checkout', '--quiet', repo, kit]);
    git(['-C', kit, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', head]);
    const seconds = { clone: elapsed(from) };
    check(
      git(['-C', kit, 'status', '--porcelain'], { encoding: 'utf8' }).trim() === '',
      `${kit} is a clean checkout of ${head}`,
    );
    const cloneBytes = await bytesOf(kit);
    from = Date.now();
    const installed = await run(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', 'pnpm install --frozen-lockfile'],
      { env, cwd: kit, log: out('kit-install') },
    );
    seconds.install = elapsed(from);
    check(installed.status === 0, 'pnpm install --frozen-lockfile in the second clone exit 0');
    const installBytes = (await bytesOf(kit)) - cloneBytes;
    await oldUnchanged('after the second clone and its install');

    step('3. SIPGES open (the old version, synthetic data): the kit refuses and writes nothing');
    const oldStart = await run(
      POWERSHELL,
      psArgs(join(old, 'deploy', 'desktop', 'windows', 'start.ps1')),
      { env, log: out('old-start'), seconds: 240 },
    );
    check(oldStart.status === 0, 'the clone start.ps1 started the server and ended (exit 0)');
    check(await healthy(), `${BASE}/health answers`);
    const secrets = await seed(BASE, original, work);
    say('synthetic data seeded: 2 projects, records, links, uploads, admin with MFA, a second account');
    const analystBefore = await analystSignsIn(BASE, secrets.analystPassword);
    check(analystBefore.status === 200, 'the second account signs in on the old version');
    // From the second clone: the same commit as the zip of the kit, so compare.mjs accepts it.
    const before = join(work, 'sipges-antes.json');
    const snapshot = await runNode(
      [
        join(kit, 'deploy', 'desktop', 'migration', 'snapshot.mjs'),
        '--url',
        BASE,
        '--out',
        before,
        ...LOGIN(secrets, original),
      ],
      { log: out('snapshot') },
    );
    check(snapshot.status === 0 && snapshot.output.includes('Written:'), 'snapshot.mjs exit 0');
    mkdirSync(keyUsb, { recursive: true });
    mkdirSync(salida, { recursive: true });
    const intoOld = await kitRun('kit-into-old-clone', old);
    check(
      intoOld.status === 1 && intoOld.output.includes('está dentro del clon viejo'),
      'visit-kit.mjs --out <old clone>: exit 1, «está dentro del clon viejo»',
    );
    const whileOpen = await kitRun('kit-while-open', salida);
    check(
      whileOpen.status === 1 &&
        whileOpen.output.includes('SIPGES está abierto: algo responde en http://127.0.0.1:8000.'),
      'visit-kit.mjs while SIPGES answers: exit 1, «SIPGES está abierto»',
    );
    check(
      !existsSync(key) && readdirSync(salida).length === 0,
      'the refusals wrote no key and no kit',
    );
    await oldUnchanged('after the refusals');
    await endServer('old version');
    say('old version ended (its node process, as the runbook does in Task Manager)');
    const originalDigest = digest(await tree(original));
    const ladBefore = await sipgesFolders(lad);

    step('4. SIPGES closed: the kit from the second clone, key on its USB, kit in a laptop folder');
    from = Date.now();
    const made = await kitRun('kit', salida);
    seconds.kit = elapsed(from);
    const visit = join(salida, VISIT_FOLDER);
    const release = join(visit, `release-${version}`);
    check(
      // The kit prints its folders resolved through links; the names are what matter here.
      made.status === 0 &&
        made.output.includes(`Release ${version} signed: `) &&
        made.output.includes(`\\${VISIT_FOLDER}\\release-${version}`) &&
        made.output.includes('Kit listo: '),
      `visit-kit.mjs exit 0: «Kit listo: …\\${VISIT_FOLDER}»`,
    );
    check(existsSync(key), 'the key was created in the «key USB» folder');
    check(
      JSON.stringify(readdirSync(visit).sort()) ===
        JSON.stringify(['LEEME.txt', SCRIPTS_ZIP, 'fingerprint.txt', `release-${version}`].sort()),
      `${VISIT_FOLDER} holds the release, ${SCRIPTS_ZIP}, fingerprint.txt and LEEME.txt only`,
    );
    const measures = {
      seconds,
      cloneBytes,
      installBytes,
      buildBytes: (await bytesOf(kit)) - cloneBytes - installBytes,
      releaseBytes: await bytesOf(release),
    };
    const lines = measureLines(measures);
    await writeFile(join(logs, 'measures.txt'), `${lines.join('\n')}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Kit built on the laptop (measured)\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`,
      );
    for (const line of lines) say(`measure: ${line}`);
    const failures = checkMeasures(measures);
    check(
      failures.length === 0,
      `the measures leave twice the room the kit and the runbook ask for${failures.length ? `: ${failures.join('; ')}` : ''}`,
    );
    await oldUnchanged('after the kit');
    check(await openOld('shortcuts-after-kit', old), 'both shortcuts still open the old clone');
    check(
      (await sipgesFolders(lad)) === ladBefore,
      'the SIPGES folders of LOCALAPPDATA are the same, byte for byte, after the kit',
    );

    step('5. The runbook from the kit: scripts unpacked, copy of the data, managed install');
    const zip = join(visit, SCRIPTS_ZIP);
    const unpack = await psLines(
      work,
      'unpack',
      [
        'New-Item -ItemType Directory "$env:LOCALAPPDATA\\SIPGES-visita" | Out-Null',
        `Copy-Item ${quotePs(zip)} "$env:LOCALAPPDATA\\SIPGES-visita"`,
        `Expand-Archive -LiteralPath "$env:LOCALAPPDATA\\SIPGES-visita\\${SCRIPTS_ZIP}" -DestinationPath "$env:LOCALAPPDATA\\SIPGES-visita\\sipges"`,
        'Test-Path "$env:LOCALAPPDATA\\SIPGES-visita\\sipges\\deploy\\desktop\\windows\\install.ps1"',
      ],
      { env, log: out('unpack') },
    );
    const scripts = join(lad, 'SIPGES-visita', 'sipges', 'deploy', 'desktop');
    check(
      unpack.status === 0 && unpack.output.trim().endsWith('True'),
      'the scripts of the kit unpacked with Expand-Archive (Test-Path: True)',
    );
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
    const counts = copied.output.split(/\r?\n/).filter((line) => line.includes('archivos:'));
    check(
      copied.status === 0 &&
        counts.length === 2 &&
        JSON.stringify(parseCount(counts[0])) === JSON.stringify(parseCount(counts[1])),
      'Copy-Item: the two count lines are equal',
    );
    check(digest(await tree(moved)) === originalDigest, 'the copy is byte-identical');
    const fingerprint = (await readFile(join(visit, 'fingerprint.txt'), 'utf8')).trim();
    const install = await run(
      POWERSHELL,
      psArgs(join(scripts, 'windows', 'install.ps1'), ['-Release', release, '-State', moved]),
      { env, log: out('managed-install') },
    );
    check(install.status === 0, 'install.ps1 -Release <kit release> -State <copy> exit 0');
    check(
      install.output.includes(
        `Trusting the update key that signed this release (SHA-256 ${fingerprint}).`,
      ),
      'the installer prints the fingerprint of fingerprint.txt',
    );
    check(install.output.includes(`Installed ${version}`), `Installed ${version}`);
    check(install.output.includes(INSTALLED_LINE), 'the installer accents arrive as typed');
    const repointed = await shortcutLines('shortcuts-managed');
    check(
      repointed.length === 2 && repointed.every((line) => line.endsWith('\\SIPGES-app\\start.ps1"')),
      'the managed install repointed both shortcuts to SIPGES-app\\start.ps1',
    );
    await oldUnchanged('after the managed install');

    step('6. First start on the copy, the managed version, comparison');
    const first = await runNode(
      [
        join(appRoot, 'versions', version, 'updater', 'update.mjs'),
        '--install',
        appRoot,
        '--first-start',
      ],
      { log: out('first-start') },
    );
    check(
      first.status === 0 && first.output.includes(`First start of ${version} done.`),
      'update.mjs --first-start exit 0',
    );
    const managed = launch(POWERSHELL, psArgs(join(appRoot, 'start.ps1')), {
      env: { ...env, SIPGES_DESKTOP_NO_UI: '1' },
      log: out('managed-start'),
    });
    await waitFor('the managed start', 240, healthy, managed);
    say('managed SIPGES answers on port 8000');
    const compared = await runNode(
      [
        join(scripts, 'migration', 'compare.mjs'),
        '--before',
        before,
        '--url',
        BASE,
        ...LOGIN(secrets, moved),
      ],
      { log: out('compare') },
    );
    check(
      compared.status === 0 && compared.output.includes('RESULT: no difference'),
      'compare.mjs: RESULT: no difference',
    );
    check(!/not (fully )?checked/.test(compared.output), 'compare.mjs: every part checked');
    check(
      sameAccess(analystBefore, await analystSignsIn(BASE, secrets.analystPassword)),
      'the second account signs in and opens the same projects',
    );
    check(
      digest(await tree(original)) === originalDigest,
      'the original state folder is byte-identical',
    );
    await oldUnchanged('at the end');
    killTree(managed.pid);
    await endServer('managed version');
    await managed.ended;

    say(`\n${PASSED}`);
  } finally {
    cleanUpOnce();
    say(`logs copied to ${logs}: ${collected.join(', ') || 'none'}`);
    say(`work folder kept (synthetic data only): ${work}; the throwaway key was deleted`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const line = `LAPTOP KIT REHEARSAL FAILED: ${error.message}`;
    console.error(line);
    if (logPath) appendFileSync(logPath, `${line}\n`);
    process.exitCode = 1;
  });
}
