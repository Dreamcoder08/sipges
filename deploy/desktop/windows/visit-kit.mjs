// The visit kit in one command (docs/deployment/desktop-visit.es.md, «Antes de salir de casa»):
//
//   node deploy\desktop\windows\visit-kit.mjs --version <semver> --key <K:\key.pem> --out <F:\>
//
// Run it on Windows from a clean checkout of the definitive commit, after
// `pnpm install --frozen-lockfile`. At the visit it runs on the laptop itself, from a second clone
// in its own folder (C:\SIPGES-kit), never the old clone the SIPGES shortcuts open
// (docs/deployment/desktop-visit.es.md, «Armar el kit en la laptop»). Before building it refuses,
// with a Spanish message and nothing written, when Node.js is older than 24 or pnpm 12 is missing
// (printing the fix), the checkout is not installed or not clean, this checkout, --key or --out is
// inside the old clone or this checkout inside %LOCALAPPDATA%\SIPGES*, SIPGES answers on port 8000
// (she is working), a package of this version is already in .data\desktop-packages and is not a
// failed build of this checkout (a failed one, which builder.mjs keeps and would refuse to build
// over, is removed: the only thing the kit ever deletes), or a drive lacks the free space below.
// It
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
// --out is the visit USB or, with a single USB (the key's), a laptop folder outside the
// repository, the old clone and %LOCALAPPDATA%\SIPGES* (C:\SIPGES-kit-salida).
import { spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import { connect } from 'node:net';
import { Buffer } from 'node:buffer';
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
// install.ps1, start.ps1 and start-managed.ps1 serve SIPGES on this port.
export const SIPGES_PORT = 8000;

const GiB = 1024 ** 3;
// Free space the kit asks for before building: BUILD_FREE on the drive of this checkout (the
// package in .data\desktop-packages and apps\web\dist) and KIT_FREE on the drive of --out (the
// signed copy of the package); both on one drive, the sum. Twice what CI measures at most: the
// laptop-kit job of .github/workflows/windows-desktop.yml fails when a measured size passes half.
export const BUILD_FREE = 1 * GiB;
export const KIT_FREE = 1 * GiB;
// What the runbook asks free on C: before `git clone` (clone, node_modules, the build and the
// kit). The same job fails when twice its measured total passes it.
export const LAPTOP_FREE_GB = 5;
const PNPM_FIX = '«npm install -g pnpm@12.11.2», abrí una terminal nueva y repetí el comando.';
// What deploy/desktop/package/builder.mjs writes first in a package folder and, last, when the
// build finished (visit-kit.test.mjs checks they are the builder's). Not imported from it: the
// builder loads TypeScript, and the kit must refuse an uninstalled checkout with its own message.
export const PACKAGE_MARKER = '.sipges-desktop-package';
export const PACKAGE_MARKER_TEXT = 'Generated package; failed builds are retained.\n';
export const PACKAGE_COMPLETE = '.sipges-package-complete';
// Holds builder.mjs's process id from before the marker until after the completion file.
export const PACKAGE_BUILDING = '.sipges-package-building';
// What builder.mjs adds to web/index.html in its last step before the completion file: a package
// with it and no completion file may have been finished by an older builder.mjs.
const DESKTOP_MARK = '<meta name="sipges-desktop" content="1" />';
const CLONE_ELSEWHERE =
  'Cloná el commit definitivo en otra carpeta (C:\\SIPGES-kit) y corré el kit desde ahí.';

const USAGE = `Usage: node deploy/desktop/windows/visit-kit.mjs --version <semver> --key <private.pem> --out <folder>

Builds and signs the definitive SIPGES version and writes the visit folder <out>\\${VISIT_FOLDER}:
release-<version>, ${SCRIPTS_ZIP}, fingerprint.txt and LEEME.txt (docs/deployment/desktop-visit.es.md).
--key is the Ed25519 signing key, on its own USB: created when the file does not exist, reused
otherwise; never inside the repository, %LOCALAPPDATA%\\SIPGES* or <out>\\${VISIT_FOLDER}.
--out is an existing folder: the visit USB (its root) or, with one USB only, a laptop folder
outside the repository, the old clone and %LOCALAPPDATA%\\SIPGES* (C:\\SIPGES-kit-salida).
Windows only, from a clean second clone after pnpm install --frozen-lockfile, never inside the
laptop's old clone. Refuses before building when Node.js is older than 24, pnpm 12 is missing,
SIPGES answers on port ${SIPGES_PORT}, a finished package of this version (or a folder builder.mjs
did not make) is in .data\\desktop-packages, or a drive has less free space than the build needs.
A failed build of this version there (builder.mjs's marker, no completion file) is removed first.`;

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

/** The folders whose start.ps1 the SIPGES shortcuts open (their Arguments lines): the old clones. */
export function oldClones(shortcutArguments) {
  const clones = [];
  for (const line of shortcutArguments.split(/\r?\n/)) {
    const match = /-File\s+"([^"]+)\\deploy\\desktop\\windows\\start\.ps1"\s*$/i.exec(line.trim());
    if (match && !clones.some((clone) => clone.toLowerCase() === match[1].toLowerCase()))
      clones.push(match[1]);
  }
  return clones;
}

/** Free space shown as the runbook writes it: GB with one decimal and a decimal comma. */
const gb = (bytes) => `${(bytes / GiB).toFixed(1).replace('.', ',')} GB`;

/** Why this Node.js cannot build the kit, with the fix, or null. */
export function nodeRefusal(version) {
  if (Number(version.split('.')[0]) >= 24) return null;
  return `Node.js ${version} es anterior a 24: el kit necesita Node.js 24 o posterior. No instales ni actualices Node.js en la laptop durante la visita (la versión vieja de SIPGES usa este Node): hoy no se instala nada (regla de corte del kit).`;
}

/** Why this pnpm (its --version, or null when missing) cannot build the kit, with the fix, or null. */
export function pnpmRefusal(version) {
  if (version === null) return `Falta pnpm: instalalo con ${PNPM_FIX}`;
  if (/^12\./.test(version)) return null;
  return `pnpm ${version} no sirve: este repositorio usa pnpm 12. Instalalo con ${PNPM_FIX}`;
}

/** The refusal while SIPGES answers on its port: the build must not run while she works. */
export function sipgesRefusal(answers) {
  if (!answers) return null;
  return `SIPGES está abierto: algo responde en http://127.0.0.1:${SIPGES_PORT}. El kit no se arma mientras la usuaria trabaja: cerrá SIPGES por completo («SIPGES cerrado», sección 2 del runbook) y repetí el comando.`;
}

/** Why the drives of the checkout and --out lack the free space of the build, or null. */
export function spaceRefusal({ checkout, out, freeCheckout, freeOut, sameDrive: shared }) {
  if (shared) {
    const need = BUILD_FREE + KIT_FREE;
    if (freeCheckout >= need) return null;
    return `Falta espacio en el disco de ${checkout} y de --out ${out} (el mismo disco): hay ${gb(freeCheckout)} libres y el kit necesita ${gb(need)} (el paquete en este clon y su copia firmada en --out). Liberá espacio o usá --out en otro disco y repetí el comando.`;
  }
  if (freeCheckout < BUILD_FREE)
    return `Falta espacio en el disco de este clon (${checkout}): hay ${gb(freeCheckout)} libres y el kit necesita ${gb(BUILD_FREE)} para construir el paquete. Liberá espacio y repetí el comando.`;
  if (freeOut < KIT_FREE)
    return `Falta espacio en --out ${out}: hay ${gb(freeOut)} libres y el kit necesita ${gb(KIT_FREE)} para la versión firmada. Usá otro USB o liberá espacio y repetí el comando.`;
  return null;
}

/**
 * Why this checkout, --key or --out is a place of the laptop the kit never writes in: the old
 * clones (the folders the SIPGES shortcuts open) and, for the checkout, a SIPGES folder of
 * %LOCALAPPDATA% (refusePaths covers --key and --out there). Paths are absolute.
 */
export function placeRefusal({ checkout, key, out, clones, localAppData, pathApi = path }) {
  const within = (parent, child) => {
    const r = pathApi.relative(parent, child);
    return r === '' || (r !== '..' && !r.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(r));
  };
  for (const clone of clones) {
    if (pathApi.relative(clone, checkout) === '')
      return `Los accesos directos «SIPGES» abren este clon (${checkout}): es el clon viejo de la laptop y el kit no escribe en él. ${CLONE_ELSEWHERE}`;
    if (within(clone, checkout))
      return `Este clon (${checkout}) está dentro del clon viejo ${clone}, el que abren los accesos directos «SIPGES»: el kit no escribe en él. ${CLONE_ELSEWHERE}`;
  }
  if (localAppData && within(localAppData, checkout)) {
    const first = pathApi.relative(localAppData, checkout).split(pathApi.sep)[0];
    if (first.toLowerCase().startsWith('sipges'))
      return `Este clon (${checkout}) está dentro de una carpeta SIPGES de %LOCALAPPDATA%, la de la instalación: el kit no escribe ahí. ${CLONE_ELSEWHERE}`;
  }
  for (const clone of clones) {
    if (within(clone, key))
      return `--key ${key} está dentro del clon viejo ${clone}: la clave va en su propio USB.`;
    if (within(clone, out))
      return `--out ${out} está dentro del clon viejo ${clone}: el kit va al USB de la visita o a una carpeta aparte (C:\\SIPGES-kit-salida).`;
  }
  return null;
}

/**
 * The builder.mjs arguments for this checkout, from the checkout path as this script was started
 * (never its real path): builder.mjs compares --out with its own folder as text, so another letter
 * case (Windows) or a resolved link would be refused. The last one is the package folder.
 */
export function builderCommand({ repo: checkout, version }) {
  return [
    join(checkout, 'deploy', 'desktop', 'package', 'builder.mjs'),
    '--version',
    version,
    '--out',
    join(checkout, '.data', 'desktop-packages', `sipges-${version}`),
  ];
}

/** Whether a process with this id exists (signal 0 only asks; EPERM means it exists). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

// A process id file is `<pid>\n`: far shorter than this. One this long or longer is not one.
const PID_FILE_BYTES = 64;

/** The text of a process id file, at most PID_FILE_BYTES read; null when unreadable or that long. */
function readPidFile(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(PID_FILE_BYTES);
    const read = readSync(fd, buffer, 0, PID_FILE_BYTES, 0);
    return read < PID_FILE_BYTES ? buffer.toString('utf8', 0, read) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Removes a file or a link (a junction too) itself; a read-only file (Windows) once more after chmod. */
function removeEntry(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    // chmod follows links: a link that cannot be removed must never change its target.
    if (lstatSync(path).isSymbolicLink()) throw error;
    chmodSync(path, 0o666);
    unlinkSync(path);
  }
}

/** Removes a tree without following any link: a link (or junction) is removed itself. */
function removeTree(path) {
  const info = lstatSync(path);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const name of readdirSync(path)) removeTree(join(path, name));
    rmdirSync(path);
  } else removeEntry(path);
}

/**
 * Before building: the package folder of this version in this checkout
 * (<checkout>\.data\desktop-packages\sipges-<version>), when a build failed there. builder.mjs
 * keeps a failed folder and refuses to build over it, so a retry would always fail. The folder is
 * removed only when it is provably the kit's own failed build: a real folder (no link) under real
 * .data and desktop-packages folders of this checkout, holding builder.mjs's marker with its
 * exact text and neither its completion file nor the desktop mark of its last step, whose builder
 * (its recorded process id) no longer runs. Anything
 * else is refused with the folder to delete by hand; nothing outside that folder is touched.
 * Returns `{ removed, refusal }`: the removed folder or null, the refusal or null.
 */
export async function clearFailedPackage({ checkout, version }) {
  // A version is one folder name: never a path (`1.0.0/../..`) that reaches outside.
  if (!isVersion(version))
    return { removed: null, refusal: `Invalid semantic version: ${version}` };
  const data = join(checkout, '.data');
  const packages = join(data, 'desktop-packages');
  const dir = join(packages, `sipges-${version}`);
  const kind = (path) => {
    try {
      return lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const refuse = (refusal) => ({ removed: null, refusal });
  for (const parent of [data, packages]) {
    const info = kind(parent);
    if (!info) return { removed: null, refusal: null };
    if (info.isSymbolicLink() || !info.isDirectory())
      return refuse(
        `${parent} es un enlace o no es una carpeta: el kit no borra nada a través de él y builder.mjs no construye ahí. Quitá ese enlace (no lo que contiene) y repetí el comando.`,
      );
  }
  const info = kind(dir);
  if (!info) return { removed: null, refusal: null };
  const notBuilder = refuse(
    `${dir} no es un paquete que haya dejado builder.mjs (es un enlace, no es una carpeta o le falta su marca ${PACKAGE_MARKER}): el kit no la borra. Revisá qué es, borrá esa carpeta (solo ${dir}) y repetí el comando.`,
  );
  // With a valid version and .data, desktop-packages and the folder each a real folder (lstat,
  // no link or junction), the folder is <checkout>\.data\desktop-packages\sipges-<version>.
  if (info.isSymbolicLink() || !info.isDirectory()) return notBuilder;
  const marker = kind(join(dir, PACKAGE_MARKER));
  if (!marker?.isFile() || readFileSync(join(dir, PACKAGE_MARKER), 'utf8') !== PACKAGE_MARKER_TEXT)
    return notBuilder;
  const index = join(dir, 'web', 'index.html');
  const marked = kind(index)?.isFile() && readFileSync(index, 'utf8').includes(DESKTOP_MARK);
  if (kind(join(dir, PACKAGE_COMPLETE)) || marked)
    return refuse(
      `Ya hay un paquete terminado de la versión ${version} en ${dir}: el kit no lo borra. Para armar el kit de nuevo con esta versión, borrá esa carpeta (solo ${dir}) y repetí el comando.`,
    );
  // A marker without a completion file is also a build still running: its builder wrote its
  // process id before the marker. Alive, or unreadable as a process id: nothing is removed.
  const building = join(dir, PACKAGE_BUILDING);
  if (kind(building)) {
    const text = kind(building).isFile() ? readPidFile(building) : null;
    const pid = text !== null && /^[1-9]\d*\n$/.test(text) ? Number(text) : null;
    if (pid === null || alive(pid))
      return refuse(
        `Hay otra construcción de la versión ${version} en curso en ${dir} (o no se puede saber si terminó): el kit no borra nada. Esperá a que termine esa terminal; si ya no hay ninguna construyendo, borrá esa carpeta (solo ${dir}) y repetí el comando.`,
      );
  }
  // The marker goes last: if removing stops half-way, the next run still proves the folder its own.
  for (const name of readdirSync(dir)) if (name !== PACKAGE_MARKER) removeTree(join(dir, name));
  removeEntry(join(dir, PACKAGE_MARKER));
  rmdirSync(dir);
  return { removed: dir, refusal: null };
}

/**
 * The laptop checks, in order, before anything is built: the first refusal (a message) or null.
 * Each probe is asked only when every check before it passed. `probes`: nodeVersion (string),
 * and the functions pnpmVersion (string or null), installed, clean, shortcuts (the Arguments
 * lines of this account's SIPGES shortcuts), sipgesAnswers, failedPackage (removes a failed
 * build of this version, clearFailedPackage; returns its refusal or null) and space
 * ({ freeCheckout, freeOut, sameDrive }); the functions may be async.
 */
export async function preflight({ checkout, key, out, localAppData, pathApi = path, probes }) {
  const node = nodeRefusal(probes.nodeVersion);
  if (node) return node;
  const pnpm = pnpmRefusal(await probes.pnpmVersion());
  if (pnpm) return pnpm;
  if (!(await probes.installed()))
    return 'this checkout is not installed: run pnpm install --frozen-lockfile';
  if (!(await probes.clean()))
    return 'this checkout has uncommitted changes (git status --short): the package must be exactly a commit';
  const clones = oldClones(await probes.shortcuts());
  const place = placeRefusal({ checkout, key, out, clones, localAppData, pathApi });
  if (place) return place;
  const open = sipgesRefusal(await probes.sipgesAnswers());
  if (open) return open;
  // After the SIPGES check (never while she works) and before the space: a failed build may be
  // what filled the drive.
  const failed = await probes.failedPackage();
  if (failed) return failed;
  return spaceRefusal({ checkout, out, ...(await probes.space()) });
}

/** Whether something accepts a TCP connection on the port (loopback), within `ms`. */
export function portAnswers(port, host = '127.0.0.1', ms = 2000) {
  return new Promise((done) => {
    const socket = connect({ port, host });
    const end = (answers) => {
      socket.destroy();
      done(answers);
    };
    socket.setTimeout(ms, () => end(false));
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
  });
}

/** Bytes free for this account on the drive of an existing folder. */
export const freeBytes = (folder) => {
  const stats = statfsSync(folder);
  return stats.bavail * stats.bsize;
};

/** Whether two existing folders are on the same drive (volume). */
export const sameDrive = (a, b) => statSync(a).dev === statSync(b).dev;

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
    'comandos con las rutas de este kit. Si el kit está en un USB y Windows le da otra letra,',
    'cambiala en cada comando. Esta carpeta no lleva datos, contraseñas ni la clave de firma.',
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
    '  Siempre con -State: sin él la versión nueva migra la carpeta original. Comprobalo',
    `  (stateDir tiene que terminar en SIPGES-datos): Get-Content "${app}\\install.json"`,
    '',
    'Paso 4 - Primer arranque sobre la copia (tiene que terminar en 0)',
    `  node "${app}\\versions\\${version}\\updater\\update.mjs" --install "${app}" --first-start`,
    '  $LASTEXITCODE',
    '',
    'Paso 5 - Comparar (con SIPGES abierto y un código MFA nuevo; RESULT: no difference y 0)',
    `  node "${scripts}\\migration\\compare.mjs" --before "$env:LOCALAPPDATA\\SIPGES-visita\\sipges-antes.json" --url http://127.0.0.1:8000`,
    '  $LASTEXITCODE',
    `  Antes de comparar dice: Managed install: version ${version}`,
    '  RESULT: not compared (...) y 2: nada se comparó (responde otro SIPGES, hubo una redirección o se cortó la conexión).',
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
    '[ ] Si el kit está en un USB, expulsalo con «Quitar hardware de forma segura».',
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

/** `pnpm --version`, or null when pnpm does not answer. A fixed command line through the shell:
 * on Windows pnpm is a .cmd shim, which Node starts only through cmd.exe. */
function pnpmVersion() {
  const result = spawnSync('pnpm --version', {
    shell: true,
    encoding: 'utf8',
    env: childEnv(process.env),
    windowsHide: true,
  });
  const version = (result.stdout ?? '').trim();
  return result.status === 0 && /^\d+\.\d+\.\d+/.test(version) ? version : null;
}

/** The Arguments lines of this account's SIPGES shortcuts (Start menu and Desktop). */
function shortcutArguments() {
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
  // As written in the shortcut; a link on the way would hide the old clone, so resolve it.
  return oldClones(shortcuts.stdout)
    .map((clone) => `-File "${existsSync(clone) ? real(clone) : clone}\\deploy\\desktop\\windows\\start.ps1"`)
    .join('\r\n');
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
  const checkout = real(repo);
  const refusal = await preflight({
    checkout,
    key,
    out,
    localAppData,
    probes: {
      nodeVersion: process.versions.node,
      pnpmVersion,
      installed: () => existsSync(join(repo, 'node_modules', 'typescript')),
      clean: () => git(['status', '--porcelain']).trim() === '',
      shortcuts: shortcutArguments,
      sipgesAnswers: () => portAnswers(SIPGES_PORT),
      failedPackage: async () => {
        const { removed, refusal } = await clearFailedPackage({ checkout, version: options.version });
        if (removed) console.log(`Paquete incompleto de un intento anterior borrado: ${removed}`);
        return refusal;
      },
      space: () => ({
        freeCheckout: freeBytes(checkout),
        freeOut: freeBytes(out),
        sameDrive: sameDrive(checkout, out),
      }),
    },
  });
  if (refusal) throw new Error(refusal);
  const commit = git(['rev-parse', 'HEAD']).trim();
  console.log(`Visit kit ${options.version} from ${commit}`);

  console.log('\n== (a) builder.mjs');
  const command = builderCommand({ repo, version: options.version });
  const packageDir = command.at(-1);
  const built = spawnSync(process.execPath, command, { cwd: repo, stdio: 'inherit' });
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
