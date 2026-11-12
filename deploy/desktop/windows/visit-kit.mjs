// The visit kit in one command (docs/deployment/desktop-visit.es.md, «Antes de salir de casa»):
//
//   node deploy\desktop\windows\visit-kit.mjs --version <semver> --key <K:\key.pem> --out <F:\>
//
// Run it on Windows from a clean checkout of the definitive commit, after
// `pnpm install --frozen-lockfile`: another PC, or the laptop itself in a separate folder, never
// inside the laptop's old clone (its build is the one the old shortcuts open). It
//   (a) builds the package with deploy/desktop/package/builder.mjs;
//   (b) creates the Ed25519 signing key at --key when that file does not exist yet (the path is
//       meant to be on the key USB), otherwise reuses it;
//   (c) signs the release with deploy/desktop/updater/release.mjs (notes «Versión definitiva de
//       la visita»);
//   (d) writes <out>\SIPGES-visita\: release-<version>\, sipges-scripts.zip (deploy/desktop of
//       HEAD, as the runbook packs it), fingerprint.txt (the key's SHA-256, the same the
//       installer prints) and LEEME.txt (the runbook's commands with this kit's paths);
//   (e) prints the final checklist.
// The key never goes into the repository, into %LOCALAPPDATA%\SIPGES* or into the visit folder.
import { spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path, { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import {
  PUBLIC_KEY,
  createRelease,
  isVersion,
  keyFingerprint,
  loadPublicKey,
  readRelease,
} from '../updater/release.mjs';
import { childEnv, packScripts } from './drill.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
export const NOTES = 'Versión definitiva de la visita';
export const VISIT_FOLDER = 'SIPGES-visita';
export const SCRIPTS_ZIP = 'sipges-scripts.zip';

const USAGE = `Usage: node deploy/desktop/windows/visit-kit.mjs --version <semver> --key <private.pem> --out <folder>

Builds and signs the definitive SIPGES version and writes the visit folder <out>\\${VISIT_FOLDER}:
release-<version>, ${SCRIPTS_ZIP}, fingerprint.txt and LEEME.txt (docs/deployment/desktop-visit.es.md).
--key is the Ed25519 signing key, on its own USB: created when the file does not exist, reused
otherwise; never inside the repository, %LOCALAPPDATA%\\SIPGES* or <out>\\${VISIT_FOLDER}.
--out is the visit USB (its root), an existing folder. Windows only, from a clean checkout after
pnpm install --frozen-lockfile, never inside the laptop's old clone.`;

/** The kit's options: all three required, each once. */
export function parseKitOptions(args) {
  const keys = { '--version': 'version', '--key': 'key', '--out': 'out' };
  const given = {};
  for (let i = 0; i < args.length; i += 2) {
    const [key, value] = [args[i], args[i + 1]];
    if (!keys[key] || !value || value.startsWith('--') || given[keys[key]] !== undefined)
      throw new Error('Invalid options; use --help');
    given[keys[key]] = value;
  }
  for (const [flag, name] of Object.entries(keys))
    if (given[name] === undefined) throw new Error(`Missing ${flag}`);
  if (!isVersion(given.version)) throw new Error(`Invalid semantic version: ${given.version}`);
  return given;
}

/**
 * Why the key or the visit folder is in a forbidden place, or null. `pathApi` is node:path's
 * win32 or posix flavour (win32 compares without case). Paths are absolute.
 */
export function refusePaths({ key, out, repo: checkout, localAppData, pathApi = path }) {
  const within = (parent, child) => {
    const r = pathApi.relative(parent, child);
    return r === '' || (r !== '..' && !r.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(r));
  };
  // %LOCALAPPDATA%\SIPGES, SIPGES-app, SIPGES-datos, SIPGES-visita and their copies: the laptop.
  const laptop = (target) => {
    if (!localAppData || !within(localAppData, target)) return false;
    const first = pathApi.relative(localAppData, target).split(pathApi.sep)[0];
    return first.toLowerCase().startsWith('sipges');
  };
  const visit = pathApi.join(out, VISIT_FOLDER);
  if (within(checkout, key))
    return `--key ${key} is inside the repository ${checkout}: the signing key never goes into the repository`;
  if (laptop(key))
    return `--key ${key} is inside a SIPGES folder of %LOCALAPPDATA%: the signing key never goes to the laptop`;
  if (within(out, key) || within(key, out))
    return `--key ${key} and --out ${out} overlap: the signing key never travels on the visit USB`;
  if (within(checkout, out))
    return `--out ${out} is inside the repository ${checkout}: write the kit to the visit USB`;
  if (laptop(visit))
    return `--out ${out} is inside a SIPGES folder of %LOCALAPPDATA%: write the kit to the visit USB`;
  return null;
}

/** Whether one of the SIPGES shortcuts (their Arguments lines) opens this checkout's start.ps1. */
export function opensCheckout(shortcutArguments, checkout) {
  const start = `${checkout}\\deploy\\desktop\\windows\\start.ps1"`.toLowerCase();
  return shortcutArguments.split(/\r?\n/).some((line) => line.trim().toLowerCase().endsWith(start));
}

/** LEEME.txt: the runbook's commands for this kit, in Spanish; no data, password or key path. */
export function leeme({ version, commit, fingerprint, visit, built }) {
  const win = path.win32;
  const release = win.join(visit, `release-${version}`);
  const zip = win.join(visit, SCRIPTS_ZIP);
  const scripts = '$env:LOCALAPPDATA\\SIPGES-visita\\sipges\\deploy\\desktop';
  const app = '$env:LOCALAPPDATA\\SIPGES-app';
  // As the runbook types them, quoted only when the USB path has a space.
  const arg = (value) => (/\s/.test(value) ? `"${value}"` : value);
  return [
    'SIPGES - kit de la visita',
    '',
    `Versión:  ${version}`,
    `Commit:   ${commit}`,
    `Armado:   ${built}`,
    `Huella SHA-256 de la clave de actualizaciones: ${fingerprint}`,
    '',
    'Esta hoja no reemplaza el runbook impreso (docs/deployment/desktop-visit.es.md): trae sus',
    'comandos con las rutas de este kit. Si Windows le da a este USB otra letra, cambiala en cada',
    'comando. Este USB no lleva datos, contraseñas ni la clave de firma.',
    '',
    'Contenido',
    `  ${release}   la versión firmada; se instala desde aquí, sin copiarla`,
    `  ${zip}   instalador, snapshot.mjs y compare.mjs del mismo commit`,
    `  ${win.join(visit, 'fingerprint.txt')}   la huella de arriba`,
    '',
    'Paso 0 - Descomprimir los scripts en la laptop (tiene que decir True)',
    '  New-Item -ItemType Directory "$env:LOCALAPPDATA\\SIPGES-visita"',
    `  Copy-Item ${arg(zip)} "$env:LOCALAPPDATA\\SIPGES-visita"`,
    `  Expand-Archive -LiteralPath "$env:LOCALAPPDATA\\SIPGES-visita\\${SCRIPTS_ZIP}" -DestinationPath "$env:LOCALAPPDATA\\SIPGES-visita\\sipges"`,
    `  Test-Path "${scripts}\\windows\\install.ps1"`,
    '',
    'Paso 2 - Conteos de la versión vieja (SIPGES abierto; admin escribe su contraseña y un código MFA)',
    `  node "${scripts}\\migration\\snapshot.mjs" --url http://127.0.0.1:8000 --out "$env:LOCALAPPDATA\\SIPGES-visita\\sipges-antes.json"`,
    '',
    'Paso 3 - Instalar al lado de la vieja (antes: SIPGES cerrado, conteo, copia SIPGES-datos y',
    '         accesos directos guardados, como dice el runbook)',
    `  powershell -ExecutionPolicy Bypass -File "${scripts}\\windows\\install.ps1" -Release ${arg(release)} -State "$env:LOCALAPPDATA\\SIPGES-datos"`,
    '  Tiene que decir, con esta misma huella:',
    `  Trusting the update key that signed this release (SHA-256 ${fingerprint}).`,
    `  Installed ${version}`,
    '  SIPGES está instalado. Ábrelo desde el menú Inicio o el escritorio.',
    '',
    'Paso 4 - Primer arranque sobre la copia (tiene que terminar en 0)',
    `  node "${app}\\versions\\${version}\\updater\\update.mjs" --install "${app}" --first-start`,
    '  $LASTEXITCODE',
    '',
    'Paso 5 - Comparar (con SIPGES abierto y un código MFA nuevo; RESULT: no difference y 0)',
    `  node "${scripts}\\migration\\compare.mjs" --before "$env:LOCALAPPDATA\\SIPGES-visita\\sipges-antes.json" --url http://127.0.0.1:8000`,
    '  $LASTEXITCODE',
    '',
    'Una huella distinta, un Error, un RESULT distinto de no difference o un código distinto de 0:',
    'Regla de corte (sección 3 del runbook). La versión vieja sigue en uso.',
    '',
  ].join('\n');
}

const crlf = (text) => text.replace(/\r?\n/g, '\r\n');

/** The signing key at `key`: created (Ed25519, PKCS#8 PEM, never overwritten) or reused. */
async function signingKey(key) {
  if (!existsSync(key)) {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(key, pem, { flag: 'wx', mode: 0o600 });
    return { pem, created: true };
  }
  const pem = await readFile(key);
  let parsed;
  try {
    parsed = createPrivateKey(pem);
  } catch {
    throw new Error(`${key} is not a private key`);
  }
  if (parsed.asymmetricKeyType !== 'ed25519')
    throw new Error(`${key} is not an Ed25519 key; the updates are signed with Ed25519`);
  return { pem, created: false };
}

/**
 * Steps (b)–(d) for a built package: the key, the signed release and the rest of the visit
 * folder, which must not exist yet. Returns what the checklist names.
 */
export async function writeKit({ packageDir, key, visit, version, commit, now = new Date() }) {
  if (existsSync(visit)) throw new Error(`${visit} already exists; move it away first`);
  const { pem, created } = await signingKey(key);
  await mkdir(visit);
  const release = join(visit, `release-${version}`);
  await createRelease({ packageDir, releaseDir: release, privateKey: pem, notes: NOTES });
  // Read back as the installer does: the embedded key verifies the release and is this key.
  const embedded = loadPublicKey(await readFile(join(release, 'package', PUBLIC_KEY), 'utf8'));
  const { manifest } = await readRelease(release, embedded);
  const fingerprint = keyFingerprint(createPrivateKey(pem));
  if (manifest.version !== version || keyFingerprint(embedded) !== fingerprint)
    throw new Error('the signed release does not carry this version and key');
  console.log(`Release ${version} signed: ${release}`);
  packScripts(join(visit, SCRIPTS_ZIP));
  await writeFile(join(visit, 'fingerprint.txt'), `${fingerprint}\r\n`, { flag: 'wx' });
  const built = now.toISOString().replace(/\.\d+Z$/, 'Z');
  await writeFile(
    join(visit, 'LEEME.txt'),
    `\ufeff${crlf(leeme({ version, commit, fingerprint, visit, built }))}`,
    { flag: 'wx' },
  );
  return { release, fingerprint, created };
}

/** The final checklist, in Spanish like the runbook. */
export function checklist({ version, commit, fingerprint, created, key, visit }) {
  return [
    '',
    `Kit listo: ${visit}`,
    '',
    'Lista final (marcala también en el runbook):',
    `[ ] Anotá en «Datos de esta visita»: versión ${version}, commit ${commit},`,
    `    huella ${fingerprint}.`,
    created
      ? `[ ] La clave se creó ahora en ${key}: hacé YA una segunda copia en otro lugar (no en el repositorio, ni en el USB de la visita, ni en la laptop). Sin ella no hay más actualizaciones.`
      : `[ ] Se reutilizó la clave de ${key}: la laptop aceptará actualizaciones firmadas con ella.`,
    `[ ] Retirá ahora el USB de la clave (${dirname(key)}).`,
    `[ ] ${visit} tiene release-${version}, ${SCRIPTS_ZIP}, fingerprint.txt y LEEME.txt; nada más.`,
    '[ ] Ensayo automático con el commit de la laptop: DRILL PASSED (sección 1 del runbook).',
    '[ ] Expulsá el USB de la visita con «Quitar hardware de forma segura».',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------

/** An absolute path with its existing part resolved through links, so a link cannot hide where it is. */
function real(target) {
  let existing = resolve(target);
  const rest = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(target);
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync.native(existing), ...rest);
}

const isDir = (target) => existsSync(target) && lstatSync(target).isDirectory();

function git(args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') return console.log(USAGE);
  const options = parseKitOptions(args);
  const key = real(options.key);
  const out = real(options.out);
  const localAppData = process.env.LOCALAPPDATA ? real(process.env.LOCALAPPDATA) : null;
  const refused = refusePaths({ key, out, repo: real(repo), localAppData });
  if (refused) throw new Error(refused);
  if (!isDir(out))
    throw new Error(`--out ${out} is not an existing folder (is the visit USB connected?)`);
  if (!isDir(dirname(key)))
    throw new Error(
      `the folder of --key ${dirname(key)} does not exist (is the key USB connected?)`,
    );
  if (existsSync(key) && !lstatSync(key).isFile()) throw new Error(`--key ${key} is not a file`);
  const visit = join(out, VISIT_FOLDER);
  if (existsSync(visit)) throw new Error(`${visit} already exists; move it away first`);
  if (process.platform !== 'win32')
    throw new Error(
      'the visit kit runs on Windows only: builder.mjs builds for the system it runs on',
    );
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24)
    throw new Error(`Node.js 24 or later is needed (this is ${process.versions.node})`);
  if (!existsSync(join(repo, 'node_modules', 'typescript')))
    throw new Error('this checkout is not installed: run pnpm install --frozen-lockfile');
  if (git(['status', '--porcelain']).trim() !== '')
    throw new Error(
      'this checkout has uncommitted changes (git status --short): the package must be exactly a commit',
    );
  const shortcuts = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; foreach ($f in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) { $l = Join-Path $f 'SIPGES.lnk'; if (Test-Path -LiteralPath $l) { (New-Object -ComObject WScript.Shell).CreateShortcut($l).Arguments } }",
    ],
    { encoding: 'utf8', env: childEnv(process.env), windowsHide: true },
  );
  if (shortcuts.status !== 0)
    throw new Error(
      `could not read the SIPGES shortcuts of this account: ${shortcuts.stderr.trim()}`,
    );
  if (opensCheckout(shortcuts.stdout, real(repo)))
    throw new Error(
      `the SIPGES shortcuts open this checkout (${repo}): it is the laptop's old clone; clone the definitive commit into a separate folder`,
    );
  const commit = git(['rev-parse', 'HEAD']).trim();
  console.log(`Visit kit ${options.version} from ${commit}`);

  console.log('\n== (a) builder.mjs');
  const packageDir = join(repo, '.data', 'desktop-packages', `sipges-${options.version}`);
  const built = spawnSync(
    process.execPath,
    [
      join(repo, 'deploy', 'desktop', 'package', 'builder.mjs'),
      '--version',
      options.version,
      '--out',
      packageDir,
    ],
    { cwd: repo, stdio: 'inherit' },
  );
  if (built.status !== 0) throw new Error(`builder.mjs failed (exit code ${built.status})`);

  console.log('\n== (b)–(d) key, signed release, scripts, fingerprint.txt, LEEME.txt');
  const kit = await writeKit({ packageDir, key, visit, version: options.version, commit });
  console.log(checklist({ version: options.version, commit, key, visit, ...kit }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
